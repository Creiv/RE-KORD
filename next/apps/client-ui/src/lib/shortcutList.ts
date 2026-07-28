export type ShortcutKey = {
  text: string;
  size?: "solo" | "wide" | "default";
};

export type ShortcutItem = {
  id: string;
  keys: ShortcutKey[];
  keySep?: string;
  description: string;
};
