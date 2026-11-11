import {
  forwardRef,
  useState,
  type ImgHTMLAttributes,
  type SyntheticEvent,
} from "react";

type ImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt"> & {
  src: string;
  alt: string;
};
const fallback = "/art/afterglow.svg";

// The current shared screens only need ordinary string-src img attributes.
const Image = forwardRef<HTMLImageElement, ImageProps>(function Image(
  { src, alt, onError, ...props },
  ref,
) {
  const [failedSource, setFailedSource] = useState<string | null>(null);
  function handleError(event: SyntheticEvent<HTMLImageElement>): void {
    onError?.(event);
    if (!event.defaultPrevented && failedSource !== src && src !== fallback)
      setFailedSource(src);
  }
  return (
    <img
      {...props}
      ref={ref}
      src={failedSource === src ? fallback : src}
      alt={alt}
      onError={handleError}
    />
  );
});
export default Image;
