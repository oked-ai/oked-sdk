/** Plugin build: do not run gh, and do not use the login stored for that command. */
export function lookupPrTitleWithGh(): Promise<string | undefined> {
  return Promise.resolve(undefined);
}
