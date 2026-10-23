/* eslint-disable react/prop-types -- plain JavaScript project: shared helper components are not given PropTypes */
import { useEffect, useRef } from "react";

// Polaris web components are custom elements, and React 18 handles them differently from DOM controls:
//   - onChange on a custom element is not wired to its native "change" event, so selects and switches
//     would look alive but do nothing. These wrappers attach NATIVE listeners instead.
//   - a boolean false is written as the attribute "false", which a web component reads as true (a
//     "disabled" button that never enables). `flags` keeps only the flags that are really on.
// Each wrapper reports plain values (a string, a boolean) so callers never touch the element.

// Keeps only the true flags: <s-button {...flags({ disabled, loading })}>.
export const flags = (object) => Object.fromEntries(Object.entries(object).filter(([, on]) => Boolean(on)));

function useNativeEvent(ref, type, handler) {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const listener = (event) => latest.current(event);
    element.addEventListener(type, listener);
    return () => element.removeEventListener(type, listener);
  }, [ref, type]);
}

// Text, email, URL, search and text-area fields: <WcField as="s-text-field" value onValue={(text) => ...} />.
export function WcField({ as: Tag = "s-text-field", value, onValue, ...props }) {
  const ref = useRef(null);
  useNativeEvent(ref, "input", (event) => onValue(String(event.currentTarget.value ?? "")));
  return <Tag ref={ref} value={value} {...props} />;
}

// <WcSelect value options={[[value, label]]} onValue={(value) => ...} />
export function WcSelect({ value, options, onValue, ...props }) {
  const ref = useRef(null);
  // A select reports "change" (and some builds also "input"); both carry the same value, and callers
  // ignore a repeat of the current value.
  const handle = (event) => onValue(String(event.currentTarget.value ?? ""));
  useNativeEvent(ref, "change", handle);
  useNativeEvent(ref, "input", handle);
  return (
    <s-select ref={ref} value={String(value)} {...props}>
      {options.map(([optionValue, optionLabel]) => (
        <s-option key={optionValue} value={String(optionValue)}>
          {optionLabel}
        </s-option>
      ))}
    </s-select>
  );
}

// <WcSwitch checked onChecked={(on) => ...} />
export function WcSwitch({ checked, onChecked, ...props }) {
  const ref = useRef(null);
  useNativeEvent(ref, "change", (event) => onChecked(Boolean(event.currentTarget.checked)));
  useEffect(() => {
    if (ref.current) ref.current.checked = Boolean(checked); // keep the property in step with state
  }, [checked]);
  return <s-switch ref={ref} {...flags({ checked })} {...props} />;
}
