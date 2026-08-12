import { z } from 'zod';
import { defineTool, PAGINATION_DESCRIPTION, type ToolDefinition } from '../types.js';
import { assertProjectAllowed } from '../guards.js';
import { buildMappingContext, toTestRunSummary } from '../../jama/mapping.js';
import { htmlToMarkdown } from '../../jama/markdown.js';
import type { JamaTestCycle, JamaTestPlan, JamaTestRun } from '../../jama/types.js';
import { ServiceError } from '../../shared/errors.js';

/**
 * Toolset "test": Testplanung und Testausfuehrung.
 *
 * jama_testcycle_summary ist bewusst als Aggregation gebaut: eine Zyklus-Auswertung
 * ueber die Rohdaten wuerde bei mehreren hundert Testlaeufen das Kontextfenster
 * fuellen, obwohl der Anwender nur die Zahlen und die Fehlschlaege sehen will.
 */

const listTestPlans = defineTool({
  name: 'jama_list_testplans',
  toolset: 'test',
  title: 'Testplaene auflisten',
  description: 'Liefert die Testplaene eines Projekts.',
  inputSchema: {
    projectId: z.number().int().describe('Projekt-ID.'),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);
    const { items, total } = await context.client.http.paginate<JamaTestPlan>('testplans', {
      query: { project: args.projectId },
      limit: args.limit,
    });

    return {
      data: {
        testplaene: items.map((plan) => ({
          id: plan.id,
          name: plan.fields?.name,
          beschreibung:
            typeof plan.fields?.description === 'string'
              ? htmlToMarkdown(plan.fields.description).slice(0, 300)
              : undefined,
          angelegt: plan.createdDate,
        })),
        gesamt: total,
      },
      projectId: args.projectId,
    };
  },
});

const createTestPlan = defineTool({
  name: 'jama_create_testplan',
  toolset: 'test',
  title: 'Testplan mit Testgruppen anlegen',
  description:
    'Legt einen Testplan an und darin optional Testgruppen samt zugeordneten Testfaellen. Fasst drei aufeinander aufbauende Jama-Aufrufe zusammen, die einzeln fehleranfaellig sind, weil jeder die ID des vorherigen braucht.',
  inputSchema: {
    projectId: z.number().int().describe('Zielprojekt.'),
    name: z.string().min(1).describe('Name des Testplans.'),
    description: z.string().optional().describe('Beschreibung. Einfaches HTML ist erlaubt.'),
    testGroups: z
      .array(
        z.object({
          name: z.string().min(1).describe('Name der Testgruppe.'),
          testCaseIds: z
            .array(z.number().int())
            .default([])
            .describe('IDs der Testfaelle, die in diese Gruppe aufgenommen werden.'),
        }),
      )
      .default([])
      .describe('Testgruppen, die direkt mit angelegt werden.'),
  },
  mutating: true,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);

    const planResponse = await context.client.http.request<{ id?: number } | number>('testplans', {
      method: 'POST',
      body: {
        project: args.projectId,
        fields: { name: args.name, description: args.description },
      },
    });
    const planId =
      typeof planResponse.data === 'number'
        ? planResponse.data
        : (planResponse.data as { id?: number })?.id;

    if (planId === undefined) {
      throw new ServiceError(
        'JAMA_UNEXPECTED',
        'Jama hat beim Anlegen des Testplans keine ID zurueckgeliefert.',
        502,
      );
    }

    const gruppen: Array<{ name: string; id?: number; testfaelle: number; fehler?: string }> = [];

    for (const group of args.testGroups) {
      try {
        const groupResponse = await context.client.http.request<{ id?: number } | number>(
          `testplans/${planId}/testgroups`,
          { method: 'POST', body: { name: group.name } },
        );
        const groupId =
          typeof groupResponse.data === 'number'
            ? groupResponse.data
            : (groupResponse.data as { id?: number })?.id;

        let zugeordnet = 0;
        for (const testCaseId of group.testCaseIds) {
          await context.client.http.request(`testplans/${planId}/testgroups/${groupId}/testcases`, {
            method: 'POST',
            body: { item: testCaseId },
          });
          zugeordnet += 1;
        }
        gruppen.push({ name: group.name, id: groupId, testfaelle: zugeordnet });
      } catch (error) {
        gruppen.push({
          name: group.name,
          testfaelle: 0,
          fehler: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const fehlerhafte = gruppen.filter((group) => group.fehler);

    context.audit({
      action: 'testplan.create',
      targetType: 'testplan',
      targetKey: String(planId),
      payload: { projectId: args.projectId, name: args.name, gruppen: gruppen.length },
      result: fehlerhafte.length > 0 ? 'error' : 'ok',
    });

    return {
      data: { angelegt: true, testplanId: planId, gruppen },
      projectId: args.projectId,
      notes:
        fehlerhafte.length > 0
          ? [
              `Der Testplan wurde angelegt, aber ${fehlerhafte.length} Gruppen konnten nicht vollstaendig erstellt werden. Der Plan ist damit unvollstaendig.`,
            ]
          : undefined,
    };
  },
});

const listTestCycles = defineTool({
  name: 'jama_list_testcycles',
  toolset: 'test',
  title: 'Testzyklen auflisten',
  description: 'Liefert die Testzyklen eines Projekts oder eines bestimmten Testplans.',
  inputSchema: {
    projectId: z.number().int().describe('Projekt-ID.'),
    testPlanId: z.number().int().optional().describe('Auf einen Testplan einschraenken.'),
    limit: z.number().int().min(1).max(200).default(50).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    assertProjectAllowed(args.projectId, context);
    const { items, total } = await context.client.http.paginate<JamaTestCycle>('testcycles', {
      query: { project: args.projectId },
      limit: args.limit,
    });

    const gefiltert =
      args.testPlanId === undefined
        ? items
        : items.filter((cycle) => cycle.testPlan === args.testPlanId);

    return {
      data: {
        testzyklen: gefiltert.map((cycle) => ({
          id: cycle.id,
          name: cycle.fields?.name,
          testplan: cycle.testPlan,
          startDatum: cycle.fields?.startDate,
          endDatum: cycle.fields?.endDate,
          angelegt: cycle.createdDate,
        })),
        gesamt: total,
      },
      projectId: args.projectId,
    };
  },
});

const createTestCycle = defineTool({
  name: 'jama_create_testcycle',
  toolset: 'test',
  title: 'Testzyklus anlegen',
  description:
    'Legt einen Testzyklus zu einem Testplan an. Jama erzeugt dabei automatisch die Testlaeufe fuer die enthaltenen Testfaelle.',
  inputSchema: {
    testPlanId: z.number().int().describe('Testplan, zu dem der Zyklus gehoert.'),
    name: z.string().min(1).describe('Name des Zyklus.'),
    startDate: z.string().optional().describe('Startdatum (ISO 8601).'),
    endDate: z.string().optional().describe('Enddatum (ISO 8601).'),
    testGroupsToInclude: z
      .array(z.number().int())
      .optional()
      .describe('IDs der Testgruppen, die in den Zyklus aufgenommen werden. Ohne Angabe: alle.'),
  },
  mutating: true,
  handler: async (args, context) => {
    const body: Record<string, unknown> = {
      fields: { name: args.name, startDate: args.startDate, endDate: args.endDate },
    };
    if (args.testGroupsToInclude) {
      body.testRunGenerationConfig = { testGroupsToInclude: args.testGroupsToInclude };
    }

    const response = await context.client.http.request<{ id?: number } | number>(
      `testplans/${args.testPlanId}/testcycles`,
      { method: 'POST', body },
    );
    const id =
      typeof response.data === 'number' ? response.data : (response.data as { id?: number })?.id;

    context.audit({
      action: 'testcycle.create',
      targetType: 'testcycle',
      targetKey: String(id),
      payload: { testPlanId: args.testPlanId, name: args.name },
      result: 'ok',
    });

    return { data: { angelegt: true, testzyklusId: id, testplanId: args.testPlanId } };
  },
});

const listTestRuns = defineTool({
  name: 'jama_list_testruns',
  toolset: 'test',
  title: 'Testlaeufe auflisten',
  description:
    'Liefert die Testlaeufe eines Zyklus, optional nach Status gefiltert — etwa alle noch offenen oder alle fehlgeschlagenen.',
  inputSchema: {
    testCycleId: z.number().int().describe('Testzyklus.'),
    status: z
      .enum(['NOT_RUN', 'PASSED', 'FAILED', 'BLOCKED', 'INPROGRESS'])
      .optional()
      .describe('Auf einen Ausfuehrungsstatus einschraenken.'),
    limit: z.number().int().min(1).max(300).default(100).describe(PAGINATION_DESCRIPTION),
  },
  mutating: false,
  handler: async (args, context) => {
    const { items, total } = await context.client.http.paginate<JamaTestRun>(
      `testcycles/${args.testCycleId}/testruns`,
      { limit: args.limit },
    );

    const gefiltert = args.status
      ? items.filter((run) => run.fields?.testRunStatus === args.status)
      : items;

    const mapping = await buildMappingContext(context.client.schema, []);

    return {
      data: {
        testlaeufe: gefiltert.map((run) => toTestRunSummary(run, mapping)),
        gesamt: total,
        gefiltert: gefiltert.length,
      },
    };
  },
});

const updateTestRun = defineTool({
  name: 'jama_update_testrun',
  toolset: 'test',
  title: 'Testlauf-Ergebnis eintragen',
  description:
    'Traegt das Ergebnis eines Testlaufs ein, optional mit Einzelergebnissen je Testschritt und einem Kommentar. Entspricht dem, was ein Tester in der Oberflaeche erfassen wuerde.',
  inputSchema: {
    testRunId: z.number().int().describe('Testlauf.'),
    status: z
      .enum(['NOT_RUN', 'PASSED', 'FAILED', 'BLOCKED', 'INPROGRESS'])
      .describe('Gesamtergebnis des Laufs.'),
    comment: z.string().optional().describe('Anmerkung zum Ergebnis, etwa die Fehlerursache.'),
    executionDate: z
      .string()
      .optional()
      .describe('Ausfuehrungszeitpunkt (ISO 8601). Ohne Angabe setzt Jama den aktuellen.'),
    steps: z
      .array(
        z.object({
          index: z.number().int().min(0).describe('Nullbasierter Index des Schritts.'),
          status: z.enum(['NOT_RUN', 'PASSED', 'FAILED', 'BLOCKED']).describe('Ergebnis des Schritts.'),
          notes: z.string().optional().describe('Anmerkung zum Schritt.'),
        }),
      )
      .optional()
      .describe('Einzelergebnisse je Testschritt.'),
  },
  mutating: true,
  handler: async (args, context) => {
    const run = await context.client.http.getOptional<JamaTestRun>(`testruns/${args.testRunId}`);
    if (!run) {
      throw new ServiceError('JAMA_NOT_FOUND', `Testlauf ${args.testRunId} existiert nicht.`, 404);
    }
    assertProjectAllowed(run.project, context);

    const fields: Record<string, unknown> = { testRunStatus: args.status };
    if (args.executionDate) fields.executionDate = args.executionDate;
    if (args.comment) fields.actualResults = args.comment;

    if (args.steps && args.steps.length > 0) {
      const existing = run.fields?.testRunSteps ?? [];
      const steps = existing.map((step, index) => {
        const update = args.steps?.find((entry) => entry.index === index);
        return update ? { ...step, status: update.status, notes: update.notes ?? step.notes } : step;
      });
      fields.testRunSteps = steps;
    }

    await context.client.http.request(`testruns/${args.testRunId}`, {
      method: 'PUT',
      body: { fields },
    });

    context.audit({
      action: 'testrun.update',
      targetType: 'testrun',
      targetKey: run.documentKey ?? String(args.testRunId),
      payload: { status: args.status, schritte: args.steps?.length },
      result: 'ok',
    });

    return {
      data: { aktualisiert: true, testRunId: args.testRunId, status: args.status },
      projectId: run.project,
    };
  },
});

const testCycleSummary = defineTool({
  name: 'jama_testcycle_summary',
  toolset: 'test',
  title: 'Testzyklus auswerten',
  description:
    'Wertet einen Testzyklus aus: Verteilung der Ergebnisse, Fortschritt und die Liste der fehlgeschlagenen und blockierten Laeufe mit Begruendung. Liefert bewusst Kennzahlen statt Rohdaten, damit auch grosse Zyklen ins Kontextfenster passen.',
  inputSchema: {
    testCycleId: z.number().int().describe('Auszuwertender Testzyklus.'),
    maxRuns: z
      .number()
      .int()
      .min(10)
      .max(1000)
      .default(300)
      .describe('Obergrenze der ausgewerteten Laeufe.'),
  },
  mutating: false,
  handler: async (args, context) => {
    const { items, total } = await context.client.http.paginate<JamaTestRun>(
      `testcycles/${args.testCycleId}/testruns`,
      { limit: args.maxRuns },
    );

    const verteilung: Record<string, number> = {};
    const auffaellig: Array<{
      id: number;
      name?: string;
      status?: string;
      anmerkung?: string;
      bearbeiter?: string;
    }> = [];

    const mapping = await buildMappingContext(context.client.schema, []);

    for (const run of items) {
      const status = run.fields?.testRunStatus ?? 'UNBEKANNT';
      verteilung[status] = (verteilung[status] ?? 0) + 1;

      if (status === 'FAILED' || status === 'BLOCKED') {
        const summary = toTestRunSummary(run, mapping);
        const anmerkung = run.fields?.actualResults;
        auffaellig.push({
          id: run.id,
          name: summary.name,
          status,
          anmerkung:
            typeof anmerkung === 'string' ? htmlToMarkdown(anmerkung).slice(0, 400) : undefined,
          bearbeiter: summary.assignedTo,
        });
      }
    }

    const ausgefuehrt = items.length - (verteilung.NOT_RUN ?? 0);
    const fortschritt =
      items.length === 0 ? 0 : Math.round((ausgefuehrt / items.length) * 1000) / 10;
    const erfolgsquote =
      ausgefuehrt === 0 ? 0 : Math.round(((verteilung.PASSED ?? 0) / ausgefuehrt) * 1000) / 10;

    const notes: string[] = [];
    if (total > items.length) {
      notes.push(
        `Ausgewertet wurden ${items.length} von ${total} Laeufen. Die Kennzahlen beziehen sich nur auf diesen Ausschnitt.`,
      );
    }

    return {
      data: {
        testzyklusId: args.testCycleId,
        laeufeGesamt: items.length,
        ausgefuehrt,
        fortschrittProzent: fortschritt,
        erfolgsquoteProzent: erfolgsquote,
        verteilung,
        fehlgeschlagenUndBlockiert: auffaellig,
      },
      notes: notes.length > 0 ? notes : undefined,
    };
  },
});

export const testTools: ToolDefinition[] = [
  listTestPlans,
  createTestPlan,
  listTestCycles,
  createTestCycle,
  listTestRuns,
  updateTestRun,
  testCycleSummary,
] as unknown as ToolDefinition[];
