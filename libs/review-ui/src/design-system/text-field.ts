import { css, cx } from "@linaria/core";

import { controlBoxStyles } from "./button.tsx";

/** The token input and the textarea: a 1 px `currentcolor` border with the buttons' box. */
export const textFieldStyles = cx(
  controlBoxStyles,
  css`
    font-size: var(--font-size-md);
    background-color: var(--color-input-bg);
    border: 1px solid currentcolor;
  `,
);
