import { register } from "node:module";

register("./resolve-local-ts.mjs", new URL("./", import.meta.url).href);
