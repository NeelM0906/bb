import { parentPort } from "node:worker_threads";

if (!parentPort) {
  throw new Error("fixture worker requires a parent port");
}

parentPort.on("message", (message) => {
  if (message?.type !== "request") {
    return;
  }
  const offset = message.input?.options?.offset;
  if (offset === 997) {
    process.exit(17);
  }
  if (offset === 998) {
    parentPort.postMessage({ type: "not-a-valid-response" });
    return;
  }
  if (offset === 999) {
    return;
  }
  setTimeout(
    () => {
      parentPort.postMessage({
        type: "result",
        requestId: message.requestId,
        operation: message.operation,
        result: [],
      });
    },
    offset === 1 ? 40 : 5,
  );
});

setTimeout(() => parentPort.postMessage({ type: "ready" }), 10);
