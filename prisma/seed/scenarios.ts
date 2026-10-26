/**
 * Demo scenarios.
 *
 * Each is a real inbound message written the way a maintenance superintendent
 * or a buyer actually writes one — partial, occasionally contradictory, with
 * the important number buried mid-paragraph. Nothing about the outcome is
 * staged: each case ends where it does because the catalog, the stock table
 * and the policy thresholds make it end there.
 */

export type PostRun =
  | "none"
  | "approve_all"
  | "approve_and_complete"
  | "reject_first"
  | "changes_requested"
  | "leave_unprocessed";

export interface ScenarioDef {
  reference: string;
  subject: string;
  body: string;
  accountNumber: string;
  siteKey: string;
  contactKey: string;
  ownerEmail: string;
  receivedDaysAgo: number;
  receivedHour: number;
  channel: "EMAIL" | "PORTAL" | "PHONE" | "EDI";
  postRun: PostRun;
  /** What this case is meant to demonstrate — shown in the seed output. */
  demonstrates: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Resolve `{{DATE+N}}` placeholders to a calendar date N days after `now`
 * (written the way a customer would, e.g. "Oct 12"), so a date-sensitive
 * scenario means the same thing whenever the demo is seeded.
 */
export function renderScenarioBody(body: string, now: Date): string {
  return body.replace(/\{\{DATE\+(\d+)\}\}/g, (_, days: string) => {
    const d = new Date(now.getTime() + Number(days) * 86400000);
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  });
}

export const SCENARIOS: ScenarioDef[] = [
  {
    reference: "REQ-2041",
    subject: "Line 4 pump replacement — need a quote",
    body: `Hi,

We're replacing the pumps on Line 4 at the Dallas plant. We currently run AX-220 units there but the loop is being converted to thermal fluid and will sit at 180 C continuous, so we need something rated for higher temperature.

Need 12 units delivered to the Dallas plant within two weeks — the line is down from the 30th and we can't miss that window.

The existing baseplates and pipework are staying, so whatever you propose has to land on what's already there. If the AX-220 can't be made to work please recommend something compatible.

Can you quote this?

Thanks,
Ben Hollis
Maintenance Superintendent`,
    accountNumber: "ACC-10044",
    siteKey: "dallas",
    contactKey: "hollis",
    ownerEmail: "dana.whitfield@example-distribution.com",
    receivedDaysAgo: 1,
    receivedHour: 8,
    channel: "EMAIL",
    postRun: "none",
    demonstrates:
      "Substitution on a hard temperature failure, two alternatives rejected for concrete technical reasons, split fulfillment, three approvals routed",
  },
  {
    reference: "REQ-2038",
    subject: "MX-160 — 5 off for the Charlotte plant",
    body: `Morning,

Could you price up 5 off MX-160 for us? Same as the units on the glycol skid — 316 stainless, ATEX Zone 1 area, 460V 3ph, DN50 connections, running around 35 m3/h at 90 C.

No great rush but I'd like them on site inside the month.

Thanks
Sam Arroyo
Plant Engineer, Cascade Foods`,
    accountNumber: "ACC-10102",
    siteKey: "charlotte",
    contactKey: "arroyo",
    ownerEmail: "marcus.oyelaran@example-distribution.com",
    receivedDaysAgo: 3,
    receivedHour: 9,
    channel: "EMAIL",
    postRun: "none",
    demonstrates: "Exact SKU match, stock available, everything inside policy — releases with no approval",
  },
  {
    reference: "REQ-2035",
    subject: "New thermal oil loop, No.2 machine — 10 pumps",
    body: `We're specifying pumps for the new thermal oil loop on the No.2 machine at Green Bay.

Duty is 50 m3/h at 45 m head, hot oil at 190 C continuous. 316 stainless wetted parts, 460 V 3 phase 60 Hz supply. Piping isn't finalised yet so connection size is flexible at this stage.

Quantity 10. Our shutdown window opens {{DATE+21}} and everything has to be on site before then — that date does not move.

Please come back with what you'd recommend and lead times.

Irene Kowalski
Reliability Engineer, Northgate Paper`,
    accountNumber: "ACC-10156",
    siteKey: "greenbay",
    contactKey: "kowalski",
    ownerEmail: "dana.whitfield@example-distribution.com",
    receivedDaysAgo: 2,
    receivedHour: 14,
    channel: "EMAIL",
    postRun: "none",
    demonstrates:
      "Several candidates are technically valid but only one can be on site before the shutdown date",
  },
  {
    reference: "REQ-2030",
    subject: "VS-250 — 24 units, Cleveland",
    body: `Elena here at Atlas.

We need 24 x VS-250 for the Cleveland works circulation upgrade, same spec as the last batch. Ship to Cleveland.

Given the volume I'd expect our contract terms to apply. Let me know the number and when you can have them here.

Elena Duarte
Category Manager, Rotating Equipment`,
    accountNumber: "ACC-10077",
    siteKey: "cleveland",
    contactKey: "duarte",
    ownerEmail: "marcus.oyelaran@example-distribution.com",
    receivedDaysAgo: 4,
    receivedHour: 11,
    channel: "EMAIL",
    postRun: "none",
    demonstrates:
      "Strategic-account discount drags gross margin under the policy floor — discount, margin and quote-value approvals all fire",
  },
  {
    reference: "REQ-2026",
    subject: "Unit 7 acid transfer pump — AX-240",
    body: `Daniel Okafor, Gulf Coast Refining, Port Arthur.

We need a replacement transfer pump on the Unit 7 acid service. Spec is:

- Media: 92% sulphuric acid
- Operating temperature 150 C
- Flow 60 m3/h
- Wetted parts Hastelloy C-276, no exceptions — we've had 316 fail on this duty before
- Area is ATEX Zone 0

Our maintenance system has AX-240 listed against this position. Please quote 2 units.

This one is safety critical so I need it right rather than fast.`,
    accountNumber: "ACC-10188",
    siteKey: "portarthur",
    contactKey: "okafor",
    ownerEmail: "dana.whitfield@example-distribution.com",
    receivedDaysAgo: 2,
    receivedHour: 16,
    channel: "EMAIL",
    postRun: "none",
    demonstrates:
      "Requested part and every catalog alternative fail a hard requirement — the engine refuses to recommend anything",
  },
  {
    reference: "REQ-2044",
    subject: "pumps for the wash plant",
    body: `hi - need a few of the bigger pumps for the wash plant, similar to what we ran before. high temperature. can you get me a price?

thanks
curtis`,
    accountNumber: "ACC-10290",
    siteKey: "elko",
    contactKey: "reyes",
    ownerEmail: "marcus.oyelaran@example-distribution.com",
    receivedDaysAgo: 1,
    receivedHour: 15,
    channel: "EMAIL",
    postRun: "none",
    demonstrates: "Ambiguous request — the engine asks for what is missing instead of guessing a selection",
  },
  {
    reference: "REQ-2028",
    subject: "AX-220 x 12 against contract CTR-BW-2291",
    body: `Please supply 12 x AX-220 to the Trenton treatment works under contract CTR-BW-2291.

Standard spec, no changes from the last release. Delivery within four weeks is fine.

Joy Abara
Assistant Chief Operator, Brightwater Utilities`,
    accountNumber: "ACC-10318",
    siteKey: "trenton",
    contactKey: "abara",
    ownerEmail: "dana.whitfield@example-distribution.com",
    receivedDaysAgo: 5,
    receivedHour: 10,
    channel: "PORTAL",
    postRun: "approve_all",
    demonstrates:
      "Contract pricing applied over the price book, stock split across two distribution centres, split approved",
  },
  {
    reference: "REQ-2032",
    subject: "RG-100 replacements — blend house",
    body: `Peter Novak, Keystone Coatings.

We need 4 replacement gear pumps for the blend house at Lancaster. The existing units are RG-100.

Media is a polyester resin, around 60,000 cP at the pumping temperature, and we run it at 150 C. Existing pipework is what it is — we are not re-piping the blend house.

Shutdown is in three weeks and I need them before that.`,
    accountNumber: "ACC-10233",
    siteKey: "lancaster",
    contactKey: "novak",
    ownerEmail: "marcus.oyelaran@example-distribution.com",
    receivedDaysAgo: 6,
    receivedHour: 13,
    channel: "EMAIL",
    postRun: "changes_requested",
    demonstrates:
      "Discontinued part; the replacement only fits with an adapter kit, which is quoted as a line and flagged for engineering review",
  },
  {
    reference: "REQ-2036",
    subject: "DG-50 diaphragm pumps — 8 off",
    body: `Hello,

Looking for 8 off DG-50 for the tank farm at Savannah. Duty is transfer at 90 C, 316 stainless body, PTFE diaphragms as per the existing units.

We need them within two weeks, we're running short on spares.

Maeve Halloran
Maintenance Planner, Tidewater Processing`,
    accountNumber: "ACC-10261",
    siteKey: "savannah",
    contactKey: "halloran",
    ownerEmail: "dana.whitfield@example-distribution.com",
    receivedDaysAgo: 3,
    receivedHour: 12,
    channel: "EMAIL",
    postRun: "none",
    demonstrates:
      "Requested part cannot arrive in time; the in-stock alternative differs only in elastomer, which an engineer has to sign off",
  },
  {
    reference: "REQ-2019",
    subject: "Station 3 — AX-200-CI replacements",
    body: `Grace Mbeki, Redwood Municipal Water District.

Please quote 4 off AX-200-CI for pumping station 3. Straight like-for-like replacement of the existing units, clean water duty, nothing has changed on the installation.

Delivery within six weeks is fine.`,
    accountNumber: "ACC-10205",
    siteKey: "redwood",
    contactKey: "mbeki",
    ownerEmail: "marcus.oyelaran@example-distribution.com",
    receivedDaysAgo: 11,
    receivedHour: 9,
    channel: "EMAIL",
    postRun: "approve_and_complete",
    demonstrates: "A closed case — quoted, released and completed, with the full audit trail behind it",
  },
  {
    reference: "REQ-2046",
    subject: "Bayonne terminal — AX-280 spares enquiry",
    body: `Nadia Frazier, Cardinal Processing.

We're building the spares list for the Bayonne terminal. Can you quote 3 x AX-280 plus the matching seal kits? Duty is unchanged, 140 m3/h at 62 m, 460V, 316 stainless, ambient temperature service.

No deadline on this one, it's for budget.`,
    accountNumber: "ACC-10044",
    siteKey: "bayonne",
    contactKey: "frazier",
    ownerEmail: "dana.whitfield@example-distribution.com",
    receivedDaysAgo: 0,
    receivedHour: 7,
    channel: "EMAIL",
    postRun: "leave_unprocessed",
    demonstrates: "An unworked case in the inbox — run the analysis live during a demo",
  },
];
