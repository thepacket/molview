/** Thin wrappers over Radix primitives, styled to the application chrome. */

import type { ReactNode } from 'react';
import * as RSelect from '@radix-ui/react-select';
import * as RSlider from '@radix-ui/react-slider';
import * as RSwitch from '@radix-ui/react-switch';
import * as RTooltip from '@radix-ui/react-tooltip';
import { Check, ChevronDown } from 'lucide-react';

export function Field({ label, value, children }: {
  label: string;
  value?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <div className="field-label">
        <span>{label}</span>
        {value !== undefined && <span className="field-value">{value}</span>}
      </div>
      {children}
    </div>
  );
}

export interface SelectOption<T extends string> {
  value: T;
  label: string;
}

export function Select<T extends string>({ value, options, onChange, ariaLabel }: {
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  ariaLabel: string;
}) {
  return (
    <RSelect.Root value={value} onValueChange={(v) => onChange(v as T)}>
      <RSelect.Trigger className="select-trigger" aria-label={ariaLabel}>
        <RSelect.Value />
        <RSelect.Icon><ChevronDown size={12} /></RSelect.Icon>
      </RSelect.Trigger>
      <RSelect.Portal>
        <RSelect.Content className="select-content" position="popper" sideOffset={4}>
          <RSelect.Viewport>
            {options.map((o) => (
              <RSelect.Item key={o.value} value={o.value} className="select-item">
                <RSelect.ItemIndicator className="select-item-indicator">
                  <Check size={11} />
                </RSelect.ItemIndicator>
                <RSelect.ItemText>{o.label}</RSelect.ItemText>
              </RSelect.Item>
            ))}
          </RSelect.Viewport>
        </RSelect.Content>
      </RSelect.Portal>
    </RSelect.Root>
  );
}

export function Slider({ value, min, max, step, onChange }: {
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <RSlider.Root
      className="slider-root"
      value={[value]}
      min={min}
      max={max}
      step={step}
      onValueChange={([v]) => onChange(v)}
    >
      <RSlider.Track className="slider-track">
        <RSlider.Range className="slider-range" />
      </RSlider.Track>
      <RSlider.Thumb className="slider-thumb" />
    </RSlider.Root>
  );
}

export function Toggle({ label, checked, onChange, hint }: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  hint?: string;
}) {
  const row = (
    <label className="toggle-row">
      <span>{label}</span>
      <RSwitch.Root className="switch-root" checked={checked} onCheckedChange={onChange}>
        <RSwitch.Thumb className="switch-thumb" />
      </RSwitch.Root>
    </label>
  );
  return hint ? <Tip label={hint}>{row}</Tip> : row;
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T;
  options: readonly { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.title}
          data-active={value === o.value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tip({ label, shortcut, children, side = 'bottom' }: {
  label: string;
  shortcut?: string;
  children: ReactNode;
  side?: 'top' | 'bottom' | 'left' | 'right';
}) {
  return (
    <RTooltip.Root delayDuration={450}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content className="tooltip" side={side} sideOffset={6}>
          {label}
          {shortcut && <span className="shortcut">{shortcut}</span>}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export function Chip({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return <span className={accent ? 'chip accent' : 'chip'}>{children}</span>;
}
