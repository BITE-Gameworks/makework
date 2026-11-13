// A request/answer action between two peers of a room (Trystero's `kind: "request"` actions, or a RoomGroup's that
// route them to the room a peer is in). The shapes here are JSON the app defines (call and bridge requests carry
// mediasoup params), which don't fit Trystero's `DataPayload` type: the one cast lives here, so callers say the request
// and answer types once and the type checker holds them to it.
import type { Room } from "trystero";

export interface RequestAction<Req, Rep> {
  request(data: Req, options: { target: string; timeoutMs: number }): Promise<Rep>;
}

// `onRequest` answers the requests that reach this peer; without it this peer only asks.
export function requestAction<Req, Rep>(
  room: Pick<Room, "makeAction">,
  name: string,
  onRequest?: (data: Req, context: { peerId: string }) => Promise<Rep> | Rep,
): RequestAction<Req, Rep> {
  const make = room.makeAction as unknown as (name: string, config: {
    kind: "request";
    onRequest?: (data: Req, context: { peerId: string }) => Promise<Rep> | Rep;
  }) => RequestAction<Req, Rep>;
  return make.call(room, name, onRequest ? { kind: "request", onRequest } : { kind: "request" });
}
