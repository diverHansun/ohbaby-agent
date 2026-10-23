import type { ButtonHTMLAttributes, ReactElement, ReactNode } from "react";
import { forwardRef } from "react";

/** A borderless icon-only button; `label` is required so it always has an accessible name. */
export const IconButton = forwardRef<
  HTMLButtonElement,
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-label"> & {
    readonly label: string;
    readonly children: ReactNode;
  }
>(function IconButton(
  { label, children, className, ...rest },
  ref,
): ReactElement {
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={`ohb-icon-button${className ? ` ${className}` : ""}`}
      {...rest}
    >
      {children}
    </button>
  );
});
