/** Whether the last read of the dev solutions failed, so the pickers do not claim there are none. */
let failed = false;
export const setSolutionsFailed = (v: boolean): void => {
  failed = v;
};
export const noSolutionsText = (connected: boolean): string =>
  !connected ? "No connection" : failed ? "Solutions could not be loaded: see the error notification" : "No unmanaged solutions";
