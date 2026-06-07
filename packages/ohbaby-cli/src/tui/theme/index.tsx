import {
  createContext,
  useContext,
  useMemo,
  type ReactElement,
  type ReactNode,
} from "react";
import { detectTheme, type ThemeDetection } from "./detect.js";
import type { Theme } from "./tokens.js";

export { darkPalette, lightPalette, type RawPalette } from "./colors.js";
export {
  detectTheme,
  type DetectThemeInput,
  type ThemeDetection,
} from "./detect.js";
export {
  BRAILLE_SPINNER_FRAMES,
  createTheme,
  type ColorLevel,
  type ColorMode,
  type Theme,
} from "./tokens.js";

const defaultDetection = detectTheme();
const ThemeContext = createContext<Theme>(defaultDetection.theme);

export interface ThemeProviderProps {
  readonly children: ReactNode;
  readonly detection?: ThemeDetection;
  readonly theme?: Theme;
}

export function ThemeProvider({
  children,
  detection,
  theme,
}: ThemeProviderProps): ReactElement {
  const resolvedTheme = useMemo(
    () => theme ?? detection?.theme ?? detectTheme().theme,
    [detection, theme],
  );

  return (
    <ThemeContext.Provider value={resolvedTheme}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
