/**
 * Database seed.
 *
 * Builds the synthetic catalog, commercial data and accounts, then runs the
 * agent over each demo scenario so the application opens onto a populated
 * workspace. The scenarios are not pre-written outcomes — the seed executes
 * the same orchestrator the UI does, against the same data, so what you see
 * in the inbox is what the engines actually decided.
 */

import { PrismaClient } from "../src/generated/prisma";
import { buildCatalog, CATEGORIES, SUBSTITUTION_LINKS, ACCESSORY_LINKS } from "./seed/catalog";
import { SPEC_META } from "./seed/spec-meta";
import { COMPATIBILITY_RULES, POLICY_THRESHOLDS } from "./seed/rules";
import { buildCuratedDocs, buildSpecSheets } from "./seed/docs";
import {
  WAREHOUSES,
  PRICE_BOOKS,
  DISCOUNT_RULES,
  STOCK_OVERRIDES,
  baselineStock,
  buildFreightRules,
  makeRandom,
} from "./seed/commercial";
import { CUSTOMERS, USERS } from "./seed/accounts";
import { SCENARIOS, renderScenarioBody } from "./seed/scenarios";
import { runSalesRequest } from "../src/lib/agent/orchestrator";
import { recordAudit } from "../src/lib/audit";

const prisma = new PrismaClient();

/** One reference time (today, 09:00 UTC) so every seeded date is consistent and relative to the seed day. */
const NOW = (() => {
  const d = new Date();
  d.setUTCHours(9, 0, 0, 0);
  return d;
})();

function step(message: string) {
  process.stdout.write(`  ${message}\n`);
}

async function clear() {
  // Order matters: children before parents.
  await prisma.$transaction([
    prisma.evidence.deleteMany(),
    prisma.toolCall.deleteMany(),
    prisma.agentRun.deleteMany(),
    prisma.candidateCheck.deleteMany(),
    prisma.recommendationCandidate.deleteMany(),
    prisma.recommendation.deleteMany(),
    prisma.quoteItem.deleteMany(),
    prisma.approval.deleteMany(),
    prisma.quote.deleteMany(),
    prisma.customerResponse.deleteMany(),
    prisma.auditEvent.deleteMany(),
    prisma.requirement.deleteMany(),
    prisma.requestItem.deleteMany(),
    prisma.salesRequest.deleteMany(),
    prisma.documentSection.deleteMany(),
    prisma.technicalDocument.deleteMany(),
    prisma.incomingShipment.deleteMany(),
    prisma.inventory.deleteMany(),
    prisma.warehouse.deleteMany(),
    prisma.customerPricing.deleteMany(),
    prisma.priceBookEntry.deleteMany(),
    prisma.contact.deleteMany(),
    prisma.customerSite.deleteMany(),
    prisma.customer.deleteMany(),
    prisma.priceBook.deleteMany(),
    prisma.discountRule.deleteMany(),
    prisma.freightRule.deleteMany(),
    prisma.policyThreshold.deleteMany(),
    prisma.compatibilityRule.deleteMany(),
    prisma.accessoryLink.deleteMany(),
    prisma.substitutionLink.deleteMany(),
    prisma.productSpec.deleteMany(),
    prisma.product.deleteMany(),
    prisma.productCategory.deleteMany(),
    prisma.user.deleteMany(),
  ]);
}

async function seedCatalog() {
  await prisma.productCategory.createMany({ data: CATEGORIES });
  const categories = new Map(
    (await prisma.productCategory.findMany()).map((c) => [c.code, c.id]),
  );

  const products = buildCatalog();
  for (const product of products) {
    const categoryId = categories.get(product.categoryCode);
    if (!categoryId) throw new Error(`Unknown category ${product.categoryCode} on ${product.sku}`);

    await prisma.product.create({
      data: {
        sku: product.sku,
        name: product.name,
        categoryId,
        description: product.description,
        lifecycle: product.lifecycle,
        leadTimeDays: product.leadTimeDays,
        listPrice: product.listPrice,
        standardCost: product.standardCost,
        weightKg: product.weightKg,
        isAccessory: product.isAccessory ?? false,
        hazmat: product.hazmat ?? false,
        specs: {
          create: Object.entries(product.specs).map(([key, value]) => {
            const meta = SPEC_META[key];
            if (!meta) throw new Error(`Spec "${key}" on ${product.sku} is not in SPEC_META`);
            return {
              key,
              label: meta.label,
              type: meta.type,
              numValue: typeof value === "number" ? value : null,
              textValue: typeof value === "string" ? value : null,
              boolValue: typeof value === "boolean" ? value : null,
              unit: meta.unit ?? null,
            };
          }),
        },
      },
    });
  }
  step(`catalog — ${products.length} products (${products.filter((p) => !p.isAccessory).length} pumps, ${products.filter((p) => p.isAccessory).length} accessories) across ${CATEGORIES.length} categories`);

  const bySku = new Map((await prisma.product.findMany({ select: { id: true, sku: true } })).map((p) => [p.sku, p.id]));

  let links = 0;
  for (const link of SUBSTITUTION_LINKS) {
    const from = bySku.get(link.from);
    const to = bySku.get(link.to);
    if (!from || !to) throw new Error(`Substitution link references a missing SKU: ${link.from} → ${link.to}`);
    await prisma.substitutionLink.create({
      data: { fromProductId: from, toProductId: to, kind: link.kind, note: link.note, requiresSku: link.requiresSku },
    });
    links++;
  }
  for (const link of ACCESSORY_LINKS) {
    const host = bySku.get(link.host);
    const accessory = bySku.get(link.accessory);
    if (!host || !accessory) throw new Error(`Accessory link references a missing SKU: ${link.host} / ${link.accessory}`);
    await prisma.accessoryLink.create({
      data: { hostId: host, accessoryId: accessory, required: link.required, reason: link.reason },
    });
  }
  step(`relationships — ${links} substitution links, ${ACCESSORY_LINKS.length} accessory links`);
  return products;
}

async function seedRules() {
  await prisma.compatibilityRule.createMany({
    data: COMPATIBILITY_RULES.map((r) => ({
      code: r.code,
      dimension: r.dimension,
      label: r.label,
      specKey: r.specKey,
      requirementKey: r.requirementKey,
      operator: r.operator,
      severity: r.severity,
      tolerancePct: "tolerancePct" in r ? (r.tolerancePct as number) : null,
      appliesTo: r.appliesTo,
      explanation: r.explanation,
    })),
  });
  await prisma.policyThreshold.createMany({ data: POLICY_THRESHOLDS });
  step(
    `rules — ${COMPATIBILITY_RULES.length} compatibility rules (${COMPATIBILITY_RULES.filter((r) => r.severity === "HARD").length} hard, ${COMPATIBILITY_RULES.filter((r) => r.severity === "SOFT").length} soft), ${POLICY_THRESHOLDS.length} policy thresholds`,
  );
}

async function seedDocs(products: ReturnType<typeof buildCatalog>) {
  const bySku = new Map((await prisma.product.findMany({ select: { id: true, sku: true } })).map((p) => [p.sku, p.id]));
  const docs = [...buildSpecSheets(products, NOW), ...buildCuratedDocs(NOW)];

  for (const doc of docs) {
    await prisma.technicalDocument.create({
      data: {
        docNumber: doc.docNumber,
        title: doc.title,
        type: doc.type,
        revision: doc.revision,
        publishedAt: doc.publishedAt,
        productId: doc.productSku ? (bySku.get(doc.productSku) ?? null) : null,
        families: doc.families,
        summary: doc.summary,
        sections: { create: doc.sections },
      },
    });
  }
  const sectionCount = docs.reduce((s, d) => s + d.sections.length, 0);
  step(`technical library — ${docs.length} documents, ${sectionCount} citable sections`);
}

async function seedCommercial() {
  await prisma.warehouse.createMany({ data: WAREHOUSES });
  await prisma.priceBook.createMany({ data: PRICE_BOOKS });
  await prisma.discountRule.createMany({ data: DISCOUNT_RULES });
  const freight = buildFreightRules();
  await prisma.freightRule.createMany({ data: freight });
  step(`commercial — ${WAREHOUSES.length} warehouses, ${PRICE_BOOKS.length} price books, ${DISCOUNT_RULES.length} volume breaks, ${freight.length} freight rates`);
}

async function seedInventory() {
  const warehouses = await prisma.warehouse.findMany();
  const products = await prisma.product.findMany({ include: { category: true } });
  const overrides = new Map(STOCK_OVERRIDES.map((o) => [o.sku, o]));
  const rand = makeRandom(20260919);

  let positions = 0;
  let inbound = 0;

  for (const product of products) {
    const override = overrides.get(product.sku);
    for (const warehouse of warehouses) {
      const explicit = override?.positions.find((p) => p.warehouse === warehouse.code);
      let onHand: number;
      let reserved: number;
      let safetyStock: number;

      if (explicit) {
        onHand = explicit.onHand;
        reserved = explicit.reserved ?? 0;
        safetyStock = explicit.safetyStock ?? 0;
      } else if (override?.exclusive) {
        onHand = 0;
        reserved = 0;
        safetyStock = 0;
      } else {
        const base = baselineStock(
          product.sku,
          product.category.code,
          product.isAccessory,
          warehouse.code,
          rand,
        );
        onHand = base.onHand;
        reserved = base.reserved;
        safetyStock = base.safetyStock;
      }

      const inventory = await prisma.inventory.create({
        data: { productId: product.id, warehouseId: warehouse.id, onHand, reserved, safetyStock },
      });
      positions++;

      const incoming = override?.incoming?.filter((i) => i.warehouse === warehouse.code) ?? [];
      for (const receipt of incoming) {
        await prisma.incomingShipment.create({
          data: {
            inventoryId: inventory.id,
            quantity: receipt.quantity,
            expectedAt: new Date(NOW.getTime() + receipt.inDays * 86400000),
            poNumber: receipt.poNumber,
            confirmed: receipt.confirmed ?? true,
          },
        });
        inbound++;
      }

      // A handful of baseline lines carry a confirmed replenishment too, so
      // the "incoming stock" path is exercised outside the scripted cases.
      if (!override && onHand <= 2 && rand() > 0.72) {
        await prisma.incomingShipment.create({
          data: {
            inventoryId: inventory.id,
            quantity: 6 + Math.floor(rand() * 10),
            expectedAt: new Date(NOW.getTime() + (12 + Math.floor(rand() * 40)) * 86400000),
            poNumber: `PO-44${(7000 + Math.floor(rand() * 2000)).toString().slice(0, 4)}`,
            confirmed: true,
          },
        });
        inbound++;
      }
    }
  }
  step(`inventory — ${positions} stock positions, ${inbound} confirmed inbound receipts`);
}

async function seedAccounts() {
  await prisma.user.createMany({ data: USERS });
  const books = new Map((await prisma.priceBook.findMany()).map((b) => [b.code, b.id]));
  const bySku = new Map((await prisma.product.findMany({ select: { id: true, sku: true } })).map((p) => [p.sku, p.id]));

  let sites = 0;
  let contracts = 0;
  for (const customer of CUSTOMERS) {
    const created = await prisma.customer.create({
      data: {
        accountNumber: customer.accountNumber,
        name: customer.name,
        legalName: customer.legalName,
        industry: customer.industry,
        tier: customer.tier,
        paymentTerms: customer.paymentTerms,
        creditLimit: customer.creditLimit,
        priceBookId: books.get(customer.priceBookCode) ?? null,
        notes: customer.notes,
        sites: {
          create: customer.sites.map((s) => ({
            name: s.name,
            aliases: s.aliases,
            addressLine1: s.addressLine1,
            city: s.city,
            state: s.state,
            postalCode: s.postalCode,
            freightZone: s.freightZone,
            isPrimary: s.isPrimary ?? false,
          })),
        },
      },
      include: { sites: true },
    });
    sites += created.sites.length;

    for (const contact of customer.contacts) {
      const site = contact.siteKey
        ? created.sites.find((s) => s.name === customer.sites.find((cs) => cs.key === contact.siteKey)?.name)
        : null;
      await prisma.contact.create({
        data: {
          customerId: created.id,
          siteId: site?.id ?? null,
          name: contact.name,
          email: contact.email,
          phone: contact.phone,
          jobTitle: contact.jobTitle,
        },
      });
    }

    for (const contract of customer.contracts ?? []) {
      const productId = bySku.get(contract.sku);
      if (!productId) throw new Error(`Contract references missing SKU ${contract.sku}`);
      const from = new Date(NOW.getTime() - contract.fromDaysAgo * 86400000);
      await prisma.customerPricing.create({
        data: {
          customerId: created.id,
          productId,
          contractPrice: contract.price,
          contractRef: contract.ref,
          effectiveFrom: from,
          effectiveTo: new Date(from.getTime() + contract.forDays * 86400000),
        },
      });
      contracts++;
    }
  }
  step(`accounts — ${USERS.length} internal users, ${CUSTOMERS.length} customers, ${sites} sites, ${contracts} contract prices`);
}

async function seedRequests() {
  const users = new Map((await prisma.user.findMany()).map((u) => [u.email, u]));
  const customers = await prisma.customer.findMany({ include: { sites: true, contacts: true } });

  const created: { id: string; reference: string; postRun: string; demonstrates: string }[] = [];

  for (const scenario of SCENARIOS) {
    const customer = customers.find((c) => c.accountNumber === scenario.accountNumber);
    if (!customer) throw new Error(`Scenario ${scenario.reference} references unknown account`);
    const siteDef = CUSTOMERS.find((c) => c.accountNumber === scenario.accountNumber)!.sites.find(
      (s) => s.key === scenario.siteKey,
    )!;
    const site = customer.sites.find((s) => s.name === siteDef.name)!;
    const contactDef = CUSTOMERS.find((c) => c.accountNumber === scenario.accountNumber)!.contacts.find(
      (c) => c.key === scenario.contactKey,
    )!;
    const contact = customer.contacts.find((c) => c.name === contactDef.name)!;
    const owner = users.get(scenario.ownerEmail)!;

    const receivedAt = new Date(NOW.getTime() - scenario.receivedDaysAgo * 86400000);
    receivedAt.setUTCHours(scenario.receivedHour, 0, 0, 0);

    const request = await prisma.salesRequest.create({
      data: {
        reference: scenario.reference,
        subject: scenario.subject,
        rawBody: renderScenarioBody(scenario.body, NOW),
        channel: scenario.channel,
        status: "NEW",
        receivedAt,
        customerId: customer.id,
        siteId: site.id,
        contactId: contact.id,
        ownerId: owner.id,
      },
    });

    await recordAudit(prisma, request.id, {
      type: "REQUEST_RECEIVED",
      actor: contact.name,
      summary: `Request received by ${scenario.channel.toLowerCase()} from ${contact.name} at ${customer.name}.`,
      detail: { subject: scenario.subject, channel: scenario.channel },
    });
    await recordAudit(prisma, request.id, {
      type: "OWNER_ASSIGNED",
      actor: "Routing",
      actorId: owner.id,
      summary: `Assigned to ${owner.name}.`,
    });

    created.push({
      id: request.id,
      reference: scenario.reference,
      postRun: scenario.postRun,
      demonstrates: scenario.demonstrates,
    });
  }
  step(`requests — ${created.length} inbound cases seeded`);
  return created;
}

async function runScenarios(requests: Awaited<ReturnType<typeof seedRequests>>) {
  const manager = await prisma.user.findFirstOrThrow({ where: { role: "SALES_MANAGER" } });
  const engineer = await prisma.user.findFirstOrThrow({ where: { role: "APPLICATION_ENGINEER" } });
  const director = await prisma.user.findFirstOrThrow({ where: { role: "ADMIN" } });

  process.stdout.write("\n  Running the agent over each scenario:\n\n");

  for (const request of requests) {
    if (request.postRun === "leave_unprocessed") {
      process.stdout.write(`    ${request.reference}  left unprocessed — ${request.demonstrates}\n`);
      continue;
    }

    const outcome = await runSalesRequest(prisma, request.id, { asOf: NOW });
    const recommendation = outcome.recommendationId
      ? await prisma.recommendation.findUnique({ where: { id: outcome.recommendationId } })
      : null;

    process.stdout.write(
      `    ${request.reference}  ${(recommendation?.outcome ?? "—").padEnd(21)} ${outcome.approvalCount} approval(s)  ${outcome.status}\n`,
    );

    if (request.postRun === "approve_all" || request.postRun === "approve_and_complete") {
      const approvals = await prisma.approval.findMany({ where: { requestId: request.id, status: "PENDING" } });
      for (const approval of approvals) {
        const decider =
          approval.requiredRole === "APPLICATION_ENGINEER"
            ? engineer
            : approval.requiredRole === "ADMIN"
              ? director
              : manager;
        await prisma.approval.update({
          where: { id: approval.id },
          data: {
            status: "APPROVED",
            decidedById: decider.id,
            decidedAt: new Date(NOW.getTime() - 3600000),
            decisionNote:
              approval.kind === "SPLIT_FULFILLMENT"
                ? "Customer confirmed on the phone that two deliveries are acceptable."
                : approval.kind === "TECHNICAL_SUBSTITUTION"
                  ? "Checked against the replacement guide. Direct swap, approved."
                  : "Reviewed and approved.",
          },
        });
        await recordAudit(prisma, request.id, {
          type: "APPROVAL_GRANTED",
          actor: decider.name,
          actorId: decider.id,
          summary: `${approval.title} — approved by ${decider.name}.`,
        });
      }
      await releaseQuoteForSeed(request.id, manager.name);
    }

    if (request.postRun === "approve_and_complete") {
      // Through the real transition, so the quote reaches SENT the same way it
      // would if a person clicked the button.
      const { completeCase } = await import("../src/lib/workflow");
      await completeCase(prisma, request.id, "Dana Whitfield");
    }

    if (request.postRun === "changes_requested") {
      const approval = await prisma.approval.findFirst({
        where: { requestId: request.id, status: "PENDING" },
        orderBy: { createdAt: "asc" },
      });
      if (approval) {
        await prisma.approval.update({
          where: { id: approval.id },
          data: {
            status: "CHANGES_REQUESTED",
            decidedById: engineer.id,
            decidedAt: new Date(NOW.getTime() - 7200000),
            decisionNote:
              "Adapter route is sound but I need the suction line length from site before I sign this off — the FA-4050 pair adds roughly 180 mm and I am not convinced it fits between the existing flanges. Please get a measurement.",
          },
        });
        await recordAudit(prisma, request.id, {
          type: "APPROVAL_CHANGES_REQUESTED",
          actor: engineer.name,
          actorId: engineer.id,
          summary: `${approval.title} — changes requested by ${engineer.name}.`,
        });
        await prisma.salesRequest.update({
          where: { id: request.id },
          data: { status: "NEEDS_REVIEW" },
        });
      }
    }
  }
}

/** Mirrors the release action, so seeded released quotes go through the same gate. */
async function releaseQuoteForSeed(requestId: string, actor: string) {
  const { releaseQuote } = await import("../src/lib/workflow");
  await releaseQuote(prisma, requestId, { actor, asOf: NOW });
}

async function main() {
  process.stdout.write("\nSeeding Sales Engine\n\n");
  await clear();
  const products = await seedCatalog();
  await seedRules();
  await seedDocs(products);
  await seedCommercial();
  await seedInventory();
  await seedAccounts();
  const requests = await seedRequests();
  await runScenarios(requests);

  const [toolCalls, evidence, approvals, quotes] = await Promise.all([
    prisma.toolCall.count(),
    prisma.evidence.count(),
    prisma.approval.count(),
    prisma.quote.count(),
  ]);
  process.stdout.write(
    `\n  Executed ${toolCalls} tool calls producing ${evidence} evidence records, ${quotes} quotes and ${approvals} approval requests.\n\n  Done.\n\n`,
  );
}

main()
  .catch((error) => {
    console.error("\nSeed failed:\n", error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
