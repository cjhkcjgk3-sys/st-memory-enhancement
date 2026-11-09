// Identify the message and table state that an asynchronous request was based on.
export function captureTableContext(chat, piece) {
    if (!Array.isArray(chat) || !piece || !chat.includes(piece)) return null;
    return { chat, piece, swipe: piece.swipe_id, message: piece.mes, hashes: JSON.stringify(piece.hash_sheets ?? null) };
}

export function sameTableContext(snapshot, chat, piece) {
    return !!snapshot && chat === snapshot.chat && piece === snapshot.piece && chat.includes(piece)
        && piece.swipe_id === snapshot.swipe
        && piece.mes === snapshot.message
        && JSON.stringify(piece.hash_sheets ?? null) === snapshot.hashes;
}

// A rebuild may update existing rows, but may not silently change the schema.
export function validateRebuiltTables(tables, sheets) {
    if (!Array.isArray(tables) || !tables.length) throw new Error('整理结果中没有有效表格');
    const used = new Set();
    return tables.map((table, position) => {
        if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('整理结果包含无效表格');
        const index = table.tableIndex === undefined ? position : table.tableIndex;
        if (!Number.isInteger(index) || index < 0 || index >= sheets.length) throw new Error('整理结果中的表格编号无效');
        const sheet = table.tableUid ? sheets.find(item => item.uid === table.tableUid) : sheets[index];
        if (!sheet || (table.tableUid && table.tableIndex !== undefined && sheet !== sheets[index]) || used.has(sheet.uid))
            throw new Error('整理结果中的表格标识无效或重复');
        used.add(sheet.uid);
        const headers = sheet.getHeader().map(value => String(value ?? ''));
        if (!Array.isArray(table.columns) || table.columns.length !== headers.length ||
            table.columns.some((value, i) => String(value ?? '') !== headers[i]))
            throw new Error(`表格「${sheet.name}」的表头与原表不一致`);
        if (!Array.isArray(table.content) || table.content.some(row => !Array.isArray(row) ||
            row.length !== headers.length || row.some(value => value !== null && !['string', 'number', 'boolean'].includes(typeof value))))
            throw new Error(`表格「${sheet.name}」的行数据不完整或格式无效`);
        return { sheet, columns: headers, content: table.content.map(row => row.map(value => String(value ?? ''))) };
    });
}
