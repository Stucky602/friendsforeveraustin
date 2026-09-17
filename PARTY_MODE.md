# Party mode, cross-referenced from ltbaustin.com

The Room reads `https://ltbaustin.com/order.html` on every discover run and turns a party-mode day
into an event in the `foodie` view, scored 100 so it clears any bar.

It reads the page three ways, in this order. The first one that produces a dated result wins.

## 1. JSON-LD (recommended, and the only one that cannot break)

You own both ends of this, so publish a contract rather than making the Room guess at markup.
When party mode is on, render this into `order.html`. When it is off, render nothing.

```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "FoodEvent",
  "@id": "https://ltbaustin.com/order.html#party-2026-10-11",
  "name": "LTB party mode: Saturday",
  "startDate": "2026-10-11T18:00:00-05:00",
  "endDate": "2026-10-11T22:00:00-05:00",
  "description": "Party mode is on. Large-format trays, order by Wednesday.",
  "url": "https://ltbaustin.com/order.html",
  "location": { "@type": "FoodEstablishment", "name": "Lettuce, Turnip, The Beet" }
}
</script>
```

Rules: `startDate` must carry the offset (`-05:00` Mar to Nov, `-06:00` Nov to Mar). The word
"party mode" must appear in `name` or `description`, which is what marks it as a party day rather
than an ordinary listing. `@id` should be stable per date. Several blocks for several dates is fine.

This is roughly ten lines in whatever builds `order.html`, and it removes every guess below.

## 2. A data attribute

If JSON-LD is awkward, put the date on the element you already render:

```html
<div class="notice" data-party-mode="2026-10-11 7pm">Party mode this Saturday.</div>
```

Accepted date shapes: `2026-10-11`, `10/11`, `Oct 11`, `October 11th`, `11 October`. A bare month
and day resolves to the next occurrence. Time is optional and defaults to 6pm Central.

## 3. Plain text (works today, no LTB changes)

Failing both, the Room strips the page to text, finds the words "party mode", and looks 120
characters either side for a date. This is the fragile path. It exists so the feature works before
you touch LTB at all.

## What it will not do

It never invents a date. Text saying "party mode coming soon" with no date produces no event, and
the run reports `saw_party_text_without_date`, which is the signal that the page changed and the
text path can no longer see it. Check `GET /api/run/status` for that flag if a party day ever fails
to appear.

## Turning it off

Absence is authoritative the same day, because you control the page. The LTB fetch deliberately
bypasses the 24h scrape cache, and any party event no longer on the page is withdrawn on the next
run. Two exceptions, both deliberate: if the page is unreachable, or if it contains party-mode text
with no parseable date, nothing is withdrawn. An ambiguous page must not delete a real party day.

## The place pin

The event attaches to a place called "Lettuce, Turnip, The Beet". It has no coordinates by default,
so it appears in the night list and the calendar but not on the map. To pin it, set Worker variables
`LTB_LAT` and `LTB_LNG` (and optionally `LTB_ADDRESS`). Nothing about your address is scraped or
inferred.
