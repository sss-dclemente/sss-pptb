import { checkDist } from "../../_shared/check-dist.mjs";

checkDist(new URL("../dist/", import.meta.url).pathname);
