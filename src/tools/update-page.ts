import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { buildPageUrl, formatEditComment } from '../wikis/utils.js';

interface ApiEditResponse {
	result?: string;
	pageid?: number;
	title?: string;
	newrevid?: number;
	newtimestamp?: string;
	contentmodel?: string;
}

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	source: z
		.string()
		.describe(
			"The content to write, in the existing page's content model. Interpreted as the full page by default; as the given section's content when section is set; or as a delta (appended or prepended) when mode is set.",
		),
	latestId: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Base revision ID for edit-conflict detection; obtain from get-page with metadata=true. If omitted, the update is applied without conflict detection.',
		),
	comment: z.string().optional().describe('Summary of the edit'),
	section: z
		.union([z.number().int().nonnegative(), z.literal('new')])
		.optional()
		.describe(
			"Section to edit: 0 (full page), 1 (lead), 2..N (existing heading sections), or 'new' to append a new heading section.",
		),
	mode: z
		.union([z.enum(['append', 'prepend', 'overwrite']), z.literal('')])
		.optional()
		.describe(
			"Editing mode: 'append' to the end, 'prepend' to the start, or 'overwrite' (default) to replace the target content.",
		),
	sectionTitle: z
		.string()
		.optional()
		.describe("Heading for a new section; required when section='new', rejected otherwise."),
	bot: z
		.boolean()
		.optional()
		.describe(
			'Marks the edit as a bot edit, which Special:RecentChanges hides by default. Takes effect only when the authenticated account has the `bot` right (granted by the bot group, or by the high-volume grant on a bot password or OAuth consumer); without it the edit saves unflagged and the response reports botMarked: false. Use when performing bulk or automated edit runs, or when the user requests it.',
		),
} as const;

type UpdatePageArgs = z.infer<z.ZodObject<typeof inputSchema>>;

function normalizeArgs(args: UpdatePageArgs): UpdatePageArgs {
	const latestId = args.latestId === 0 ? undefined : args.latestId;
	const mode = args.mode === '' || args.mode === undefined ? 'overwrite' : args.mode;
	return {
		...args,
		latestId,
		comment: args.comment === '' ? undefined : args.comment,
		sectionTitle: args.sectionTitle === '' ? undefined : args.sectionTitle,
		mode,
	};
}

function validateArgs({ section, mode, sectionTitle }: UpdatePageArgs): string | undefined {
	if (section === 'new' && mode !== undefined && mode !== 'overwrite') {
		return "mode is not compatible with section='new'";
	}
	if (section === 'new' && sectionTitle === undefined) {
		return "sectionTitle is required when section='new'";
	}
	if (sectionTitle !== undefined && section !== 'new') {
		return "sectionTitle is only valid when section='new'";
	}
	return undefined;
}

function buildEditParams({
	title,
	source,
	latestId,
	comment,
	section,
	mode,
	sectionTitle,
	bot,
}: UpdatePageArgs): Record<string, string | number | boolean> {
	const sourceField =
		mode === 'append' ? 'appendtext' : mode === 'prepend' ? 'prependtext' : 'text';
	const apiSection =
		section === 'new'
			? 'new'
			: typeof section === 'number' && section > 0
				? section - 1
				: undefined;
	return {
		action: 'edit',
		title,
		summary: formatEditComment('update-page', comment),
		nocreate: true,
		[sourceField]: source,
		...(latestId !== undefined ? { baserevid: latestId } : {}),
		...(apiSection !== undefined ? { section: String(apiSection) } : {}),
		...(sectionTitle !== undefined ? { sectiontitle: sectionTitle } : {}),
		...(bot === true ? { bot: true } : {}),
	};
}

export const updatePage: Tool<typeof inputSchema> = {
	name: 'update-page',
	description:
		"Replaces the existing content of a wiki page and returns the new revision ID. Fails if the page does not exist; for new pages, use create-page. Pass latestId (obtained from get-page with metadata=true) to enable edit-conflict detection: if the page has been edited since that revision, the update is rejected rather than silently clobbering concurrent changes. For large pages, three modifiers avoid shipping the full source: section=0 replaces the full page, section=1 edits the lead, section=2..N edits named sections (pairs with get-page section=0/1..N for reads), section='new' adds a new heading section, and mode='append' or 'prepend' sends a delta. Each call is a separate revision; for chains of mode='append' calls, re-fetching latestId between calls confirms the previous chunk landed before the next.",
	inputSchema,
	annotations: {
		title: 'Update page',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'update page',
	target: (a) => a.title,

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		const normalizedArgs = normalizeArgs(args);
		const validationError = validateArgs(normalizedArgs);
		if (validationError) {
			return ctx.format.invalidInput(validationError);
		}

		const mwn = await ctx.mwn();
		const response =
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
			(await ctx.edit.submit(mwn, buildEditParams(normalizedArgs))) as
				| { edit?: ApiEditResponse }
				| undefined;
		const edit = response?.edit;
		if (!edit || edit.result !== 'Success') {
			return ctx.format.error(
				'upstream_failure',
				`Failed to update page: ${JSON.stringify(edit ?? response)}`,
			);
		}
		const resolvedTitle = edit.title ?? normalizedArgs.title;
		return ctx.format.ok({
			pageId: edit.pageid,
			title: resolvedTitle,
			latestRevisionId: edit.newrevid,
			latestRevisionTimestamp: edit.newtimestamp,
			contentModel: edit.contentmodel,
			...(normalizedArgs.bot === true ? { botMarked: await ctx.edit.botRight(mwn) } : {}),
			url: await buildPageUrl(ctx, resolvedTitle),
		});
	},
};
