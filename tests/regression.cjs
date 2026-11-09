'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { webcrypto } = require('node:crypto');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const cut = (source, start, end) => {
    const i = source.indexOf(start), j = source.indexOf(end, i);
    assert.ok(i >= 0 && j >= 0, `missing source section: ${start}`);
    return source.slice(i, j);
};
const quiet = { log() {}, warn() {}, error() {} };
const js = read('index.js'), strings = read('utils/stringUtil.js');
function parserContext(extra = {}) {
    const parser = cut(js, 'function parseArgs(', '/**\n * 清除表格中的所有空行').replace('export function countTableEditActions', 'function countTableEditActions');
    const params = cut(js, 'function formatParams(', '/**\n * 执行回复中得编辑标签');
    const loose = cut(strings, 'export function parseLooseDict(', '\n/**').replace('export function', 'function');
    const tag = cut(js, 'export function getTableEditTag(', '/**\n * 消息编辑时触发').replace('export function', 'function');
    const ctx = { console: quiet, ...extra };
    vm.createContext(ctx);
    vm.runInContext(`'use strict';\n${loose}\n${parser}\n${params}\n${tag}\nthis.parse = text => {const {matches} = getTableEditTag(text); return {matches, actions: handleTableEditTag(matches).map(a => ({...a, action: classifyParams(formatParams(a.param))}))}}; this.validate = validateTableEditActions;`, ctx);
    return ctx;
}
const plain = value => JSON.parse(JSON.stringify(value));

test('tableEdit accepts common variants without treating quoted text as actions', () => {
    const ctx = parserContext();
    const input = '<TABLEEDIT mode="changes"><!-- insertRow （0，{"0":"示例 deleteRow(1, 0)","1":"保持"}） --></TABLEEDIT>';
    const result = plain(ctx.parse(input));
    assert.equal(result.matches.length, 1);
    assert.equal(result.actions.length, 1);
    assert.equal(result.actions[0].type, 'insert');
    assert.match(result.actions[0].action.data['0'], /deleteRow\(1,\s*0\)/);
    const json = plain(ctx.parse('<tableEdit>{"operation":"insertRow","tableIndex":0,"data":{"0":"hello"}}</tableEdit>'));
    assert.equal(json.actions[0].action.data['0'], 'hello');
    assert.equal(ctx.parse('<tableEdit>insertRow(0,{"0":"x"})').matches.length, 0);
});

test('bad and truncated edits are rejected before a batch can modify rows', () => {
    const ctx = parserContext();
    const sheet = { hashSheet: [['origin', 'first', 'second']], getRowCount: () => 2 };
    const parsed = ctx.parse('<tableEdit>insertRow(0,{"0":"valid"}) updateRow(0,999,{"0":"bad"})</tableEdit>');
    assert.equal(ctx.validate(parsed.actions, [sheet]), '行编号无效');
    const truncated = ctx.parse('<tableEdit>insertRow(0,{"0":"ok"}) deleteRow(0,</tableEdit>');
    assert.ok(ctx.validate(truncated.actions, [sheet]));
    const col = ctx.parse('<tableEdit>insertRow(0,{"9":"bad"})</tableEdit>');
    assert.equal(ctx.validate(col.actions, [sheet]), '列编号或单元格数据无效');
});

function baseContext() {
    let sequence = 0;
    class Cell {
        static CellType = { sheet_origin: 'sheet_origin', column_header: 'column_header', row_header: 'row_header', cell: 'cell' };
        constructor(parent) { this.parent = parent; this.uid = `c${++sequence}`; this.type = 'cell'; this.data = {}; }
    }
    const source = read('core/table/base.js').replace(/^import .*$/gm, '').replace('export class SheetBase', 'class SheetBase');
    const ctx = { Cell, filterSavingData() {}, console: quiet };
    vm.createContext(ctx);
    vm.runInContext(`'use strict';\n${source}\nthis.SheetBase = SheetBase;`, ctx);
    return ctx;
}

test('rebuild preserves origin, zero values, column order and CSV quoting', () => {
    const { SheetBase } = baseContext();
    const sheet = new SheetBase();
    sheet.init(3, 1);
    const origin = sheet.hashSheet[0][0];
    sheet.cells.get(origin).data.note = 'keep';
    sheet.rebuildHashSheetByValueSheet([['', 'name', 'detail'], ['', 'Alice', 'a,b'], ['', 'Zero', 0]]);
    assert.equal(sheet.hashSheet[0][0], origin);
    assert.equal(sheet.cells.get(origin).data.note, 'keep');
    assert.equal(sheet.cells.get(sheet.hashSheet[2][2]).data.value, 0);
    assert.equal(sheet.getSheetCSV(), '0,Alice,"a,b"\n1,Zero,0\n');
    assert.equal(sheet.getSheetCSV(true, 'value', row => sheet.cells.get(row[1]).data.value === 'Zero'), '1,Zero,0\n');
    const before = sheet.hashSheet.map(row => [...row]);
    sheet.rebuildHashSheetByValueSheet([['', 'name', 'detail'], ['', 'Alice', 'a,b'], ['', 'Zero', 0]]);
    assert.deepEqual(plain(sheet.hashSheet), plain(before));
});

test('send-to-context setting survives serialization', async () => {
    const source = read('core/table/utils.js');
    const mod = await import('data:text/javascript,' + encodeURIComponent(source));
    const saved = mod.filterSavingData({ uid: 's', hashSheet: [], cellHistory: [], config: {}, sendToContext: false });
    assert.equal(saved.sendToContext, false);
});

test('asynchronous writes reject changed chat, swipe, message, or table', async () => {
    const mod = await import('data:text/javascript,' + encodeURIComponent(read('utils/tableSafety.js')));
    const piece = { mes: 'hello', swipe_id: 0, hash_sheets: { x: [['a']] } };
    const chat = [piece], state = mod.captureTableContext(chat, piece);
    assert.equal(mod.sameTableContext(state, chat, piece), true);
    assert.equal(mod.sameTableContext(state, [piece], piece), false);
    piece.swipe_id = 1; assert.equal(mod.sameTableContext(state, chat, piece), false); piece.swipe_id = 0;
    piece.mes = 'changed'; assert.equal(mod.sameTableContext(state, chat, piece), false); piece.mes = 'hello';
    piece.hash_sheets.x[0][0] = 'changed'; assert.equal(mod.sameTableContext(state, chat, piece), false);
});

test('rebuild rejects missing, changed or malformed fields before writing', async () => {
    const { validateRebuiltTables } = await import('data:text/javascript,' + encodeURIComponent(read('utils/tableSafety.js')));
    const sheet = { uid: 'one', name: 'People', getHeader: () => ['Name', 'Detail'] };
    const good = { tableUid: 'one', tableIndex: 0, columns: ['Name', 'Detail'], content: [['A', 'B']] };
    assert.equal(validateRebuiltTables([good], [sheet]).length, 1);
    for (const bad of [{ ...good, columns: undefined }, { ...good, columns: ['Detail', 'Name'] }, { ...good, content: [['A']] }, { ...good, tableIndex: 1 }]) {
        assert.throws(() => validateRebuiltTables([bad], [sheet]));
    }
    assert.throws(() => validateRebuiltTables([good, good], [sheet]));
});

test('table data inserted into markup is escaped', async () => {
    const { escapeHtml } = await import('data:text/javascript,' + encodeURIComponent(read('utils/escapeHtml.js')));
    assert.equal(escapeHtml(`<img src=x onerror="bad()"> & 'x'`), '&lt;img src=x onerror=&quot;bad()&quot;&gt; &amp; &#39;x&#39;');
});

test('safeParse handles apostrophes and escaped quotes in double-quoted JSON', () => {
    const source = strings.replace(/^import .*$/gm, '').replace(/^export /gm, '');
    const ctx = { USER: {}, console: quiet }; vm.createContext(ctx);
    vm.runInContext(`'use strict';\n${source}\nthis.parseJSONArrays = safeParse;`, ctx);
    const input = JSON.stringify([{ text: `Alice's [note] and "quote"` }]);
    assert.deepEqual(plain(ctx.parseJSONArrays(input))[0], JSON.parse(input));
});

test('main API fallback and first silent call work without a popup', async () => {
    const source = read('scripts/settings/standaloneAPI.js');
    const part = cut(source, 'async function createLoadingToast(', '/**\n * 处理 API 测试请求').replace('export async function', 'async function');
    const ctx = { console: quiet, Date, PopupConfirm: class { async show() { return false; } close() {} }, EDITOR: { generateRaw: async () => 'fallback' } };
    vm.createContext(ctx);
    vm.runInContext(`'use strict'; let loadingToast = null; ${part}\nthis.run = handleMainAPIRequest;`, ctx);
    ctx.TavernHelper = { generateRaw: async () => 'helper' };
    assert.equal(await ctx.run([{ role: 'user', content: 'test' }], null, true), 'helper');
    delete ctx.TavernHelper;
    assert.equal(await ctx.run([{ role: 'user', content: 'test' }], null, false), 'fallback');
});

test('default prompts parse and preserve custom settings during migration', async () => {
    const source = read('data/pluginSetting.js');
    for (const key of ['step_by_step_user_prompt', 'rebuild_default_system_message_template']) {
        const m = source.match(new RegExp(key + ': `([\\s\\S]*?)`'));
        assert.ok(m);
        const value = vm.runInNewContext('`' + m[1] + '`');
        assert.ok(Array.isArray(JSON.parse(value)));
    }
    const settings = read('scripts/settings/userExtensionSetting.js');
    const body = cut(settings, 'async function migrateUnchangedDefaultPrompts()', 'export async function loadSettings()');
    const saved = { message_template: 'user custom prompt', step_by_step_user_prompt: 'my custom prompt', rebuild_default_system_message_template: 'my custom rebuild' };
    const ctx = { USER: { tableBaseSetting: saved, tableBaseDefaultSettings: { message_template: 'new default' } }, crypto: webcrypto, TextEncoder, Uint8Array };
    vm.createContext(ctx);
    vm.runInContext(`'use strict'; ${body}\nthis.migrate = migrateUnchangedDefaultPrompts`, ctx);
    await ctx.migrate();
    assert.equal(saved.message_template, 'user custom prompt');
    assert.equal(saved.step_by_step_user_prompt, 'my custom prompt');
    assert.equal(saved.rebuild_default_system_message_template, 'my custom rebuild');
});

test('reply pipeline validates a batch before writing and permits a corrected retry', () => {
    const warnings = [], row = ['old', 'detail'];
    const sheet = {
        enable: true, hashSheet: [['origin', 'a', 'b'], ['r', 'a1', 'b1']], saved: 0,
        getRowCount() { return this.hashSheet.length; },
        findCellByPosition(r, c) {
            if (r !== 1 || c < 1 || c > 2) return null;
            return { newAction: (_action, props) => { row[c - 1] = props.value; } };
        },
        filterSavingData() { return { row: [...row] }; },
        loadJson(data) { row.splice(0, row.length, ...data.row); },
        save() { this.saved++; return this; },
    };
    const piece = { mes: '<tableEdit>updateRow(0,0,{"0":"new"}) updateRow(0,99,{"0":"bad"})</tableEdit>' };
    const ctx = parserContext({
        BASE: { getLastSheetsPiece: () => ({ piece: { hash_sheets: {} } }), hashSheetsToSheets: () => [sheet] },
        USER: { getContext: () => ({ chat: [] }) },
        EDITOR: { warning: x => warnings.push(x), error: x => warnings.push(x) },
        Cell: { CellAction: { editCell: 'editCell' } },
        fixUnescapedSingleQuotes: x => x,
    });
    const parse = cut(js, 'export function parseTableEditTag(', '/**\n * 直接通过编辑指令字符串执行操作').replace('export function', 'function');
    const exec = cut(js, 'function executeAction(', '/**\n * 格式化参数');
    vm.runInContext(`'use strict'; ${parse}\n${exec}\nthis.runReply = parseTableEditTag;`, ctx);
    assert.equal(ctx.runReply(piece), false);
    assert.deepEqual(row, ['old', 'detail']);
    assert.equal(sheet.saved, 0);
    assert.equal(piece.tableEditMatches, undefined);
    piece.mes = '<tableEdit>updateRow (0,0,{"0":"new"})</tableEdit>';
    assert.equal(ctx.runReply(piece), true);
    assert.equal(row[0], 'new');
    assert.equal(sheet.saved, 1);
    assert.ok(warnings.length);
});

test('an unexpected failure during edits restores the original cells', () => {
    const row = ['original'], errors = [];
    const sheet = {
        enable: true, hashSheet: [['origin', 'value'], ['r', 'v']], getRowCount: () => 2,
        findCellByPosition: () => ({ newAction() { row[0] = 'changed'; throw new Error('simulated failure'); } }),
        filterSavingData: () => ({ row: [...row] }),
        loadJson: data => row.splice(0, row.length, ...data.row),
        save() { return this; },
    };
    const piece = { mes: '<tableEdit>updateRow(0,0,{"0":"new"})</tableEdit>', hash_sheets: { sheet: [['old']] } };
    const ctx = parserContext({ BASE: { getLastSheetsPiece: () => ({ piece }), hashSheetsToSheets: () => [sheet] },
        USER: { getContext: () => ({ chat: [] }) }, EDITOR: { warning() {}, error: (...x) => errors.push(x) },
        Cell: { CellAction: { editCell: 'editCell' } }, fixUnescapedSingleQuotes: x => x });
    const parse = cut(js, 'export function parseTableEditTag(', '/**\n * 直接通过编辑指令字符串执行操作').replace('export function', 'function');
    const exec = cut(js, 'function executeAction(', '/**\n * 格式化参数');
    vm.runInContext(`'use strict'; ${parse}\n${exec}\nthis.runReply = parseTableEditTag;`, ctx);
    assert.equal(ctx.runReply(piece), false);
    assert.deepEqual(row, ['original']);
    assert.deepEqual(plain(piece.hash_sheets), { sheet: [['old']] });
    assert.equal(errors.length, 1);
});

test('custom API forwards nondefault top_p and leaves the default to the provider', async () => {
    const source = read('services/llmApi.js');
    const cls = cut(source, 'export class LLMApiService', 'export default LLMApiService').replace('export class', 'class');
    const requests = [];
    const ctx = { console: quiet, USER: { IMPORTANT_USER_PRIVACY_DATA: {} }, EDITOR: {},
        fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }] }) }; } };
    vm.createContext(ctx);
    vm.runInContext(`'use strict'; let ChatCompletionService; ${cls}\nthis.Service = LLMApiService;`, ctx);
    const custom = new ctx.Service({ api_url: 'https://example.test/v1', api_key: 'test', model_name: 'test', top_p: 0.8 });
    assert.equal(await custom.callLLM('hello'), 'ok');
    assert.equal(requests[0].top_p, 0.8);
    const standard = new ctx.Service({ api_url: 'https://example.test/v1', api_key: 'test', model_name: 'test', top_p: 1 });
    await standard.callLLM('hello');
    assert.equal('top_p' in requests[1], false);
});

test('external adapter reports a failed asynchronous save', async () => {
    const source = read('external-data-adapter.js').replace(/^import .*$/gm, '').replace(/^export default .*$/gm, '').replace(/^export /gm, '');
    const ctx = { console: quiet, Date, BASE: { getChatSheets: () => [{ enable: true }] },
        USER: { saveChat: async () => { throw new Error('save failed'); } },
        executeTableEditActions: () => true, getTableEditTag: () => ({ matches: ['insertRow(0,{"0":"x"})'] }),
        countTableEditActions: () => 1, updateSheetsView: async () => {} };
    vm.createContext(ctx);
    vm.runInContext(`'use strict'; ${source}\nthis.run = adapter.processJsonData.bind(adapter);`, ctx);
    const result = await ctx.run({ type: 'insert', tableIndex: 0, data: { '0': 'x' } });
    assert.equal(result.success, false);
    assert.match(result.message, /保存失败/);
});
