export interface RawPalette {
  readonly border: string;
  readonly gold: string;
  readonly goldBright: string;
  readonly green: string;
  readonly purple: string;
  readonly purpleBright: string;
  readonly red: string;
  readonly skyBlue: string;
  readonly surface: string;
  readonly text: string;
  readonly textDim: string;
  readonly textMuted: string;
  readonly textStrong: string;
  readonly userBlockBg: string;
  readonly yellow: string;
}

export const darkPalette = {
  border: "#3E3A34",
  gold: "#D4A24F",
  goldBright: "#E0B463",
  green: "#8FCB9B",
  purple: "#B9A3E3",
  purpleBright: "#C9B8EC",
  red: "#E8857D",
  skyBlue: "#6E9FCE",
  surface: "#141A12",
  text: "#E8E4DC",
  textDim: "#9A938A",
  textMuted: "#6E675F",
  textStrong: "#F5F2EC",
  userBlockBg: "#122238",
  yellow: "#E0C06B",
} as const satisfies RawPalette;

export const lightPalette = {
  border: "#C0B8AC",
  gold: "#B5832A",
  goldBright: "#C79535",
  green: "#3D9A57",
  purple: "#7C5BC4",
  purpleBright: "#8E6ED4",
  red: "#C8453E",
  skyBlue: "#2E6FB0",
  surface: "#F0EBE2",
  text: "#1A1714",
  textDim: "#5F5750",
  textMuted: "#6E675F",
  textStrong: "#0F0D0B",
  userBlockBg: "#DCEEFF",
  yellow: "#9A7B1F",
} as const satisfies RawPalette;
