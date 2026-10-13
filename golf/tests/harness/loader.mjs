// Node module hook: resolve @minecraft/server(-ui) to the in-memory mocks.
import { register } from "node:module";
register("./hooks.mjs", import.meta.url);
