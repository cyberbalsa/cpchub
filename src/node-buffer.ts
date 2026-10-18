import { Buffer as RuntimeBuffer } from "node:buffer";

// Workers' ambient Buffer placeholder overrides Node's global declaration.
// The nodejs_compat binding is the Node API; retain its full constructor type.
export const Buffer = RuntimeBuffer as BufferConstructor;
