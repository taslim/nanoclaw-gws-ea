import { expect, it } from 'vitest';
import { htmlReadings } from './html.js';
import { compilePrivateValue, givesAway } from './match.js';

it.each([
  '<!doctype html><h1>Private note</h1><p>&#84;heo</p>',
  '<h1>Private note</h1><p><span>&#84;</span><span>heo</span></p>',
  '<svg><text>Private note</text><text>&#84;heo</text></svg>',
  '<svg><text>Label</text><text><tspan>&#84;</tspan><tspan>heo</tspan></text></svg>',
])('keeps decoded block words separate while preserving split inline values: %s', (html) => {
  expect(htmlReadings(html).some((reading) => givesAway(compilePrivateValue('other', 'Theo'), reading))).toBe(true);
});

it.each([
  '<p>12 Elm R&#111;ad</p>',
  '<svg aria-label="12 Elm R&#x6f;ad"></svg>',
  '<div hidden data-secret="12 Elm Road"></div>',
  '<!--12 Elm Road--><p>Public report</p>',
  '<script>const secret="12 Elm Road"</script>',
  '<template><p>12 Elm Road</p></template>',
  '<span>12 Elm </span><strong>Road</strong>',
])('reads private details from the complete source: %s', (html) => {
  const value = compilePrivateValue('address', '12 Elm Road');
  expect(htmlReadings(html).some((reading) => givesAway(value, reading))).toBe(true);
});

it('reads standards-decoded attribute and text phone digits split by markup', () => {
  const value = compilePrivateValue('phone', '+1 415 555 0134');
  expect(htmlReadings('<p>415 <b>555</b> 01&#51;4</p>').some((reading) => givesAway(value, reading))).toBe(true);
});
