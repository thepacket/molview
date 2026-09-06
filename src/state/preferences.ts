import { create } from 'zustand';
interface Preferences {
  theme: 'dark' | 'light';
  textSize: number;
  panelWidth: number;
  inspectorWidth: number;
  diagnostics: boolean;
}
const defaults: Preferences = {
  theme: 'dark',
  textSize: 12,
  panelWidth: 340,
  inspectorWidth: 320,
  diagnostics: false,
};
function read(): Preferences {
  try {
    const v = JSON.parse(localStorage.getItem('molview-interface') || '{}');
    return {
      theme: v.theme === 'light' ? 'light' : 'dark',
      textSize: [12, 14, 16].includes(v.textSize) ? v.textSize : 12,
      panelWidth: Number.isFinite(v.panelWidth)
        ? Math.max(280, Math.min(500, v.panelWidth))
        : 340,
      inspectorWidth: Number.isFinite(v.inspectorWidth)
        ? Math.max(280, Math.min(500, v.inspectorWidth))
        : 320,
      diagnostics: v.diagnostics === true,
    };
  } catch {
    return defaults;
  }
}
export const usePreferences = create<
  Preferences & { update: (patch: Partial<Preferences>) => void }
>((set, get) => ({
  ...read(),
  update: (patch) => {
    set(patch);
    try {
      const { update: _, ...value } = get();
      localStorage.setItem('molview-interface', JSON.stringify(value));
    } catch {
      /* Storage is optional. */
    }
  },
}));
