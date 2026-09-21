import { cp, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../packages/plugin-sdk/", import.meta.url);
const destination = new URL("../dist/plugin-sdk-runtime/", import.meta.url);
await mkdir(destination, { recursive: true });
await cp(new URL("package.json", source), new URL("package.json", destination));
await cp(
  fileURLToPath(new URL("dist", source)),
  fileURLToPath(new URL("dist", destination)),
  { recursive: true },
);
