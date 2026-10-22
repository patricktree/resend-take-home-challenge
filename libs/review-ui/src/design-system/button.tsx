import { css, cx } from "@linaria/core";
import React from "react";

type DSButtonProps = React.ComponentProps<"button"> & {
  variant: "contained" | "outlined";
};

/** Cup's button (apps/web-app/src/app/design-system/button.tsx), in its two variants. */
export function DSButton({ variant, className, ...delegated }: DSButtonProps): React.ReactNode {
  return <button className={cx(buttonStyles, className)} data-variant={variant} {...delegated} />;
}

/** The padding and radius of buttons, which the text inputs share. */
export const controlBoxStyles = css`
  padding-block: calc(1 * var(--spacing-base));
  padding-inline: calc(1.5 * var(--spacing-base));
  border-radius: var(--border-radius-sm);
`;

const buttonStyles = cx(
  controlBoxStyles,
  css`
    display: inline-flex;
    gap: var(--spacing-base);
    align-items: center;
    justify-content: center;

    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-inter-figma-medium);
    color: inherit;
    background-color: transparent;
    border: 0;

    &:hover {
      cursor: pointer;
    }

    &:disabled {
      cursor: not-allowed;
    }

    &[data-variant="outlined"] {
      background-color: var(--color-bg);
      border: 1px solid currentcolor;
    }

    &[data-variant="contained"] {
      color: var(--color-input-bg);
      background-color: var(--color-primary);
    }
  `,
);
