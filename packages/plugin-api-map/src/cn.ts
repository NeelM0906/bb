import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Local copy of the app's class merger. This package renders bb theme classes
 * but must stay importable from a plugin bundle, which cannot reach into an
 * app's `@/lib` alias.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
