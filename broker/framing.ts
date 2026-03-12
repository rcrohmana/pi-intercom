// broker/framing.ts
import type { Socket } from "net";

/**
 * Write a length-prefixed message to a socket.
 * Format: 4-byte big-endian length + JSON payload
 */
export function writeMessage(socket: Socket, msg: unknown): void {
  const json = JSON.stringify(msg);
  const payload = Buffer.from(json, "utf-8");
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  socket.write(Buffer.concat([header, payload]));
}

/**
 * Create a message reader that handles partial reads.
 * Calls onMessage for each complete message received.
 */
export function createMessageReader(onMessage: (msg: unknown) => void) {
  let buffer = Buffer.alloc(0);

  return (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);

    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      
      if (buffer.length < 4 + length) {
        // Waiting for more data
        break;
      }

      const payload = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);

      try {
        const msg = JSON.parse(payload.toString("utf-8"));
        onMessage(msg);
      } catch (e) {
        console.error("Failed to parse message:", e);
      }
    }
  };
}
