// Constant-partition GSI on the Stocks table used to list every symbol with a
// Query instead of a full-table Scan. The index is KEYS_ONLY, so the listing
// crons (prices, macd) read tiny key-sized items rather than full stock rows.
// Keep these in sync with the `BySymbolList` global index defined in sst.config.ts.
export const STOCK_LIST_INDEX = "BySymbolList";
export const STOCK_LIST_PK = "gsiSymbols";
export const STOCK_LIST_PK_VALUE = "STOCK";
