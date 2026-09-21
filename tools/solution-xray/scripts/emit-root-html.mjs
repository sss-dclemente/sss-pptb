import { emitRootHtml } from "../../_shared/emit-root-html.mjs";

emitRootHtml(new URL("../", import.meta.url).pathname);
