import type { ButtonHTMLAttributes, FC } from "react";

type ButtonVariant = "primary" | "secondary" | "success" | "link";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
};

const baseClassName = "rounded-md font-medium disabled:bg-slate-400";
const variantClassNames: Record<ButtonVariant, string> = {
  primary: "bg-blue-600 text-white",
  secondary: "border border-slate-300 bg-white text-slate-950",
  success: "bg-emerald-600 text-white",
  link: "border border-blue-300 bg-white text-blue-700",
};

/**
 * Renders a consistently styled button used across the review UI.
 */
export const Button: FC<ButtonProps> = ({
  className,
  type = "button",
  variant = "secondary",
  ...props
}) => (
  <button
    className={joinClassNames(baseClassName, variantClassNames[variant], className)}
    type={type}
    {...props}
  />
);

function joinClassNames(...classNames: (string | undefined)[]): string {
  return classNames.filter((className) => className !== undefined).join(" ");
}
