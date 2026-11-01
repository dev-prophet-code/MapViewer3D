// Realtime Data (live sandworms, enemies, vehicles, storms) comes from a stream of the console's
// REST API, which the sandboxed page cannot open. The same names as web/js/realtime.js, all "off".
export const unavailableReason = () => 'sandbox';
export const keyDenied = () => false;
export const plainHttp = () => false;
export async function isAvailable() { return false; }
export function reset() {}
export function attach() { return { close() {} }; }
export async function snapshot() { throw new Error('Realtime Data is not available in the Console sandbox'); }
