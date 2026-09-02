// Fork offset: upstream is at 176. This fork's admission RPCs
// (host.admission.reserve/release/reconcile plus fail-closed thread.start /
// turn.submit checks) change the wire relative to upstream, so the fork
// version stays ahead of upstream's number to force enrolled daemons to
// update.
export const HOST_DAEMON_PROTOCOL_VERSION = 177 as const;

export const HOST_ARTIFACT_MAX_BYTES = 256 * 1024 * 1024;
