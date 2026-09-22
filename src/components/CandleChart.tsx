// Compatibility shim: the candle chart moved to TradingChart (TradingView
// Lightweight Charts). The shared up/down colours continue to live there —
// this re-export keeps the many existing import sites working.

export { UP, DOWN } from './TradingChart'
