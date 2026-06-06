const OHBABY_LOGO = [
  "  ___  _   _ ____    _    ____ __   __",
  " / _ \\| | | | __ )  / \\  | __ )\\ \\ / /",
  "| | | | |_| |  _ \\ / _ \\ |  _ \\ \\ V / ",
  "| |_| |  _  | |_) / ___ \\| |_) | | |  ",
  " \\___/|_| |_|____/_/   \\_\\____/  |_|  ",
  "                OHBABY                 ",
] as const;

export function renderOhbabyLogo(): readonly string[] {
  return OHBABY_LOGO;
}
