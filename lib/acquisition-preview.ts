/** Canonical previews are auto-oriented. Older preparation receipts contain only
 * their resized dimensions; the original metadata plus its aspect ratio still
 * identifies the oriented source frame, including EXIF axis swaps. */
export function acquisitionPreviewFrame(
  width: number, height: number, previewWidth: number, previewHeight: number,
) {
  if (![width, height, previewWidth, previewHeight].every(n => Number.isSafeInteger(n) && n > 0))
    throw new Error("Photo preview dimensions unavailable");
  const ratio = previewWidth / previewHeight;
  const swapped = Math.abs(Math.log((height / width) / ratio)) < Math.abs(Math.log((width / height) / ratio));
  return swapped ? {width: height, height: width} : {width, height};
}
