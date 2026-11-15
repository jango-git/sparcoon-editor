/** Hands a file to the browser's download. */

/** Downloads `contents` as `fileName`. */
export function downloadFile(fileName: string, contents: BlobPart, type = ""): void {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.click();
  // Revoke on a later tick: some browsers cancel the in-flight download if the object URL is
  // released synchronously, before the save has read the blob.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
