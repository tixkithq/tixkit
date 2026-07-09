'use client';

import * as React from 'react';
import {
  Archive,
  CalendarDays,
  CircleHelp,
  Code2,
  Copy,
  ExternalLink,
  Eye,
  GripVertical,
  Handshake,
  Heading1,
  Image,
  LayoutTemplate,
  ListChecks,
  MapPin,
  Minus,
  MousePointerClick,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Save,
  Share2,
  Type,
  Users,
  XCircle,
} from 'lucide-react';
import {
  Drawer,
  Puck,
  createUsePuck,
  type Config,
  type Overrides,
  type Permissions,
  type Viewports,
} from '@puckeditor/core';
import { toast } from 'sonner';
import {
  PUCK_EVENT_PAGE_PROVIDER,
  createDefaultEventPageDocument,
  materializeEventPageDocument,
  migrateLegacyEventPageDocumentToPuck,
  normalizeEventPageDocument,
  validateEventPageDocument,
  type CreateDefaultEventPageDocumentInput,
  type EventPageDocument,
  type EventPageLegacyDocument,
  type EventPagePuckComponentData,
  type EventPagePuckData,
  type EventPageSettings,
  type EventPageValidationResultV2,
} from '@tixkit/content-event-page';
import {
  EventPageRender,
  EventPageRuntimeProvider,
  createEventPagePuckConfig,
  eventPagePuckIframeConfig,
  ticketPriceLabel,
  type EventPagePuckCoreData,
  type EventPagePuckUploadImage,
  type EventPageRuntime,
} from '@tixkit/content-event-page-react/puck';
import {
  EditorChrome,
  EditorLeftRail,
  EditorTopBar,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  type DropdownMenuItemConfig,
  type EditorMode,
} from '@tixkit/content-editor-shell';
import {
  adminApi,
  type AdminBrand,
  type AdminContentDocument,
  type AdminContentDocumentVersion,
  type AdminEventDetail,
  type AdminProduct,
  type AdminTicketType,
} from '@/lib/api';
import { publicEventUrl } from '@/lib/event-links';
import { usePermissions } from '@/context/permission-provider';

type AutosaveState = 'idle' | 'saving' | 'saved' | 'error';

type EventPagePreview = {
  label: string;
  document: EventPageDocument;
  validation: EventPageValidationResultV2;
};

type EventPageEditorChrome = {
  brand?: AdminBrand;
  tickets: AdminTicketType[];
  products: AdminProduct[];
  title?: string;
  description?: string;
  startsAt?: string;
  timezone?: string;
  venueName?: string;
};

const eventPageViewports: Viewports = [
  { width: 390, height: 'auto', label: 'Mobile' },
  { width: 768, height: 'auto', label: 'Tablet' },
  { width: '100%', height: 'auto', label: 'Desktop' },
];

const cancelDropIframeStyleId = 'event-page-cancel-drop-style';

const eventPageComponentLabels: Record<string, string> = {
  EventHeader: 'Event header',
  EventDescription: 'Description',
  RichText: 'Rich text',
  Media: 'Image / media',
  Button: 'Button',
  Divider: 'Divider',
  CustomEmbed: 'Custom embed',
  EventDetails: 'Event details',
  Schedule: 'Schedule',
  Venue: 'Venue',
  FAQ: 'FAQ',
  Speakers: 'Speakers',
  Sponsors: 'Sponsors',
  SocialLinks: 'Social links',
  Tickets: 'Tickets',
  ResaleTickets: 'Resale tickets',
  CheckoutCta: 'Get tickets CTA',
  BrandFooter: 'Brand footer',
};

function eventPageComponentLabel(name: string): string {
  return eventPageComponentLabels[name] ?? name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

function eventPageComponentIcon(name: string): React.ReactNode {
  const className = 'size-4';
  switch (name) {
    case 'EventHeader':
      return <Heading1 className={className} />;
    case 'EventDescription':
      return <Type className={className} />;
    case 'RichText':
      return <Type className={className} />;
    case 'Media':
      return <Image className={className} />;
    case 'Button':
    case 'CheckoutCta':
      return <MousePointerClick className={className} />;
    case 'Divider':
      return <Minus className={className} />;
    case 'CustomEmbed':
      return <Code2 className={className} />;
    case 'EventDetails':
    case 'Tickets':
    case 'ResaleTickets':
      return <ListChecks className={className} />;
    case 'Schedule':
      return <CalendarDays className={className} />;
    case 'Venue':
      return <MapPin className={className} />;
    case 'FAQ':
      return <CircleHelp className={className} />;
    case 'Speakers':
      return <Users className={className} />;
    case 'Sponsors':
      return <Handshake className={className} />;
    case 'SocialLinks':
      return <Share2 className={className} />;
    case 'BrandFooter':
      return <LayoutTemplate className={className} />;
    default:
      return <LayoutTemplate className={className} />;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

type EventPageOutlineNode = {
  id: string;
  label: string;
  detail?: string;
  icon?: React.ReactNode;
  ownerIndex: number;
  ownerId: string;
  selectableBlockId?: string;
  children?: EventPageOutlineNode[];
  emptyLabel?: string;
};

function outlineText(value: unknown, fallback?: string): string | undefined {
  return cleanString(value) ?? fallback;
}

function outlineArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function outlineSlotItems(value: unknown): EventPagePuckComponentData[] {
  return Array.isArray(value) ? value.filter(isPuckComponentData) : [];
}

function outlineZoneItems(
  data: EventPagePuckData,
  block: EventPagePuckComponentData,
  slotName: string,
): EventPagePuckComponentData[] {
  const blockId = cleanString(block.props.id);
  if (!blockId || !data.zones) return [];
  return Object.entries(data.zones).flatMap(([zoneName, zoneContent]) => {
    const normalizedZoneName = zoneName.toLowerCase();
    if (
      !normalizedZoneName.includes(blockId.toLowerCase()) ||
      !normalizedZoneName.includes(slotName.toLowerCase())
    ) {
      return [];
    }
    return zoneContent;
  });
}

function outlineSlotNode(
  data: EventPagePuckData,
  block: EventPagePuckComponentData,
  ownerIndex: number,
  ownerId: string,
  slotName: string,
  label: string,
  emptyLabel: string,
): EventPageOutlineNode {
  const props = block.props as Record<string, unknown>;
  const slotChildren = [
    ...outlineSlotItems(props[slotName]),
    ...outlineZoneItems(data, block, slotName),
  ];
  return {
    id: `${block.props.id}:${slotName}`,
    label,
    ownerIndex,
    ownerId,
    icon: <LayoutTemplate className="size-3.5" />,
    children: slotChildren.map((child, index) => outlineNodeForBlock(data, child, index)),
    emptyLabel,
  };
}

function outlineItemNodes(
  parentId: string,
  ownerIndex: number,
  ownerId: string,
  label: string,
  items: Record<string, unknown>[],
  summaryKeys: string[],
): EventPageOutlineNode {
  return {
    id: `${parentId}:${label}`,
    label,
    detail: `${items.length} ${items.length === 1 ? 'item' : 'items'}`,
    ownerIndex,
    ownerId,
    icon: <ListChecks className="size-3.5" />,
    children: items.map((item, index) => ({
      id: `${parentId}:${label}:${index}`,
      label:
        summaryKeys.map((key) => cleanString(item[key])).find(Boolean) ??
        `${label.replace(/s$/, '')} ${index + 1}`,
      ownerIndex,
      ownerId,
      icon: <LayoutTemplate className="size-3.5" />,
    })),
    emptyLabel: 'No items',
  };
}

function flattenOutlineNodes(nodes: EventPageOutlineNode[]): EventPageOutlineNode[] {
  return nodes.flatMap((node) => [
    node,
    ...(node.children ? flattenOutlineNodes(node.children) : []),
  ]);
}

/** Root → leaf path for the selected outline node. Used for parent+selected highlighting. */
function findOutlinePath(nodes: EventPageOutlineNode[], targetId: string): string[] | null {
  for (const node of nodes) {
    if (node.id === targetId || node.selectableBlockId === targetId) {
      return [node.id];
    }
    if (!node.children?.length) continue;
    const childPath = findOutlinePath(node.children, targetId);
    if (childPath) return [node.id, ...childPath];
  }
  return null;
}

function escapeAttributeValue(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function outlineNodeForBlock(
  data: EventPagePuckData,
  block: EventPagePuckComponentData,
  index: number,
): EventPageOutlineNode {
  const props = block.props as Record<string, unknown>;
  const id = cleanString(props.id) ?? `${block.type}:${index}`;
  const ownerIndex = index;
  const ownerId = id;
  const children: EventPageOutlineNode[] = [];
  const addChild = (
    key: string,
    label: string,
    options: { detail?: string; icon?: React.ReactNode } = {},
  ) => {
    children.push({
      id: `${id}:${key}`,
      label,
      detail: options.detail,
      ownerIndex,
      ownerId,
      icon: options.icon ?? <LayoutTemplate className="size-3.5" />,
    });
  };

  switch (block.type) {
    case 'EventHeader': {
      if (props.showBrandBadge !== false) {
        addChild('badge', 'Brand badge', {
          detail: outlineText(props.brandLabel),
          icon: <LayoutTemplate className="size-3.5" />,
        });
      }
      addChild('title', 'H1 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      if (outlineText(props.description)) {
        addChild('description', 'Description copy', { detail: outlineText(props.description) });
      }
      const visibleDetails = [
        props.showDate === false ? undefined : 'Date',
        props.showTimezone === false ? undefined : 'Timezone',
        props.showVenue === false ? undefined : 'Venue',
      ].filter(Boolean);
      if (visibleDetails.length > 0) {
        addChild('details', 'Event details row', {
          detail: visibleDetails.join(', '),
          icon: <ListChecks className="size-3.5" />,
        });
      }
      if (outlineText(props.imageUrl)) {
        addChild('image', 'Background image', {
          detail: outlineText(props.imageAlt, 'No alt text'),
          icon: <Image className="size-3.5" />,
        });
      }
      const logos = outlineArray(props.logos);
      if (logos.length > 0) {
        children.push(
          outlineItemNodes(id, ownerIndex, ownerId, 'Logos', logos, [
            'name',
            'imageAlt',
            'imageUrl',
          ]),
        );
      }
      break;
    }
    case 'EventDescription': {
      if (outlineText(props.eyebrow)) {
        addChild('eyebrow', 'Eyebrow', { detail: outlineText(props.eyebrow) });
      }
      addChild('title', 'H2 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      if (outlineText(props.body)) {
        addChild('body', 'Body copy', { detail: outlineText(props.body) });
      }
      if (outlineText(props.imageUrl)) {
        addChild(
          'image',
          props.imageLayout === 'background' ? 'Background image' : 'Inline image',
          {
            detail: outlineText(props.imageAlt, 'No alt text'),
            icon: <Image className="size-3.5" />,
          },
        );
      }
      const logos = outlineArray(props.logos);
      if (logos.length > 0) {
        children.push(
          outlineItemNodes(id, ownerIndex, ownerId, 'Logos', logos, [
            'name',
            'imageAlt',
            'imageUrl',
          ]),
        );
      }
      children.push(
        outlineSlotNode(
          data,
          block,
          ownerIndex,
          ownerId,
          'imageOverlay',
          'Extra overlay content',
          'No items',
        ),
      );
      break;
    }
    case 'RichText':
      addChild('body', 'Rich text body', { detail: outlineText(props.body, 'Empty') });
      break;
    case 'Media':
      if (outlineText(props.imageUrl)) {
        addChild('image', 'Image', {
          detail: outlineText(props.imageAlt, 'No alt text'),
          icon: <Image className="size-3.5" />,
        });
      }
      if (outlineText(props.caption)) {
        addChild('caption', 'Caption', { detail: outlineText(props.caption) });
      }
      if (props.overlayEnabled === true || outlineSlotItems(props.imageOverlay).length > 0) {
        children.push(
          outlineSlotNode(
            data,
            block,
            ownerIndex,
            ownerId,
            'imageOverlay',
            'Overlay blocks',
            'No items',
          ),
        );
      }
      break;
    case 'EventDetails':
      addChild('title', 'H2 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      children.push(
        outlineItemNodes(id, ownerIndex, ownerId, 'Details', outlineArray(props.items), [
          'label',
          'value',
        ]),
      );
      break;
    case 'Schedule':
      addChild('title', 'H2 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      children.push(
        outlineItemNodes(id, ownerIndex, ownerId, 'Schedule items', outlineArray(props.items), [
          'title',
        ]),
      );
      break;
    case 'Venue':
      addChild('title', 'H2 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      if (outlineText(props.venueName))
        addChild('venue', 'Venue name', { detail: outlineText(props.venueName) });
      if (outlineText(props.address))
        addChild('address', 'Address', { detail: outlineText(props.address) });
      if (outlineText(props.mapUrl))
        addChild('map', 'Map link', { detail: outlineText(props.mapUrl) });
      break;
    case 'FAQ':
      addChild('title', 'H2 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      children.push(
        outlineItemNodes(id, ownerIndex, ownerId, 'Questions', outlineArray(props.items), [
          'question',
        ]),
      );
      break;
    case 'Sponsors':
      addChild('title', 'H2 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      children.push(
        outlineItemNodes(id, ownerIndex, ownerId, 'Sponsors', outlineArray(props.items), [
          'name',
          'imageAlt',
        ]),
      );
      break;
    case 'Speakers':
      addChild('title', 'H2 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      children.push(
        outlineItemNodes(id, ownerIndex, ownerId, 'Speakers', outlineArray(props.items), [
          'name',
          'role',
        ]),
      );
      break;
    case 'Button':
      addChild('label', 'Button label', { detail: outlineText(props.label) });
      if (outlineText(props.url))
        addChild('url', 'Button link', { detail: outlineText(props.url) });
      break;
    case 'SocialLinks':
      if (outlineText(props.title)) {
        addChild('title', 'H2 title', {
          detail: outlineText(props.title),
          icon: <Heading1 className="size-3.5" />,
        });
      }
      children.push(
        outlineItemNodes(id, ownerIndex, ownerId, 'Links', outlineArray(props.links), [
          'label',
          'url',
        ]),
      );
      break;
    case 'CustomEmbed':
      addChild('embed', props.allowUnsafeEmbed ? 'Approved embed' : 'Unapproved embed', {
        detail: outlineText(props.html, 'Empty'),
        icon: <Code2 className="size-3.5" />,
      });
      break;
    case 'Tickets':
      addChild('title', 'H2 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      addChild('ticketList', 'Ticket list', { detail: outlineText(props.previewState, 'live') });
      break;
    case 'ResaleTickets':
      addChild('title', 'H2 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      addChild('resaleList', 'Resale list', { detail: outlineText(props.previewState, 'live') });
      break;
    case 'CheckoutCta':
      addChild('label', 'CTA button', { detail: outlineText(props.label) });
      if (outlineText(props.supportingText)) {
        addChild('supportingText', 'Supporting text', {
          detail: outlineText(props.supportingText),
        });
      }
      break;
    case 'BrandFooter':
      addChild('label', 'Footer label', { detail: outlineText(props.label) });
      break;
    default:
      break;
  }

  return {
    id,
    label: eventPageComponentLabel(block.type),
    ownerIndex,
    ownerId,
    selectableBlockId: id,
    icon: eventPageComponentIcon(block.type),
    children,
  };
}

function EventPageDocumentOutline({ data }: { data: EventPagePuckData }) {
  const selectedItem = useEventPagePuck((state) => state.selectedItem);
  const dispatch = useEventPagePuck((state) => state.dispatch);
  const selectedId = isRecord(selectedItem?.props) ? cleanString(selectedItem.props.id) : undefined;
  const nodes = React.useMemo(
    () => data.content.map((block, index) => outlineNodeForBlock(data, block, index)),
    [data],
  );
  const nodeLookup = React.useMemo(
    () => new Map(flattenOutlineNodes(nodes).map((node) => [node.id, node])),
    [nodes],
  );
  const [selectedOutlineNodeId, setSelectedOutlineNodeId] = React.useState<string | undefined>(
    selectedId,
  );
  const outlineSelectionSourceRef = React.useRef<'canvas' | 'outline'>('canvas');

  React.useEffect(() => {
    if (!selectedId) return;
    setSelectedOutlineNodeId((current) => {
      if (!current) {
        outlineSelectionSourceRef.current = 'canvas';
        return selectedId;
      }
      const currentNode = nodeLookup.get(current);
      if (
        outlineSelectionSourceRef.current === 'outline' &&
        currentNode &&
        !currentNode.selectableBlockId &&
        currentNode.ownerId === selectedId
      ) {
        return current;
      }
      outlineSelectionSourceRef.current = 'canvas';
      // Prefer the exact outline node for any canvas block id (root or nested).
      const matchedPath = findOutlinePath(nodes, selectedId);
      return matchedPath?.[matchedPath.length - 1] ?? selectedId;
    });
  }, [nodeLookup, nodes, selectedId]);

  const selectionPath = React.useMemo(
    () =>
      selectedOutlineNodeId
        ? (findOutlinePath(nodes, selectedOutlineNodeId) ?? [selectedOutlineNodeId])
        : [],
    [nodes, selectedOutlineNodeId],
  );
  const selectedNodeId = selectionPath[selectionPath.length - 1];
  const ancestorNodeIds = React.useMemo(() => new Set(selectionPath.slice(0, -1)), [selectionPath]);

  const selectCanvasBlock = React.useCallback((blockId: string) => {
    const frame = window.document.querySelector<HTMLIFrameElement>(
      '[data-testid="editor-canvas"] iframe',
    );
    const frameDocument = frame?.contentDocument;
    if (!frameDocument) return false;
    const block = frameDocument.querySelector<HTMLElement>(
      `[data-block-id="${escapeAttributeValue(blockId)}"]`,
    );
    if (!block) return false;
    block.scrollIntoView({ behavior: 'auto', block: 'nearest', inline: 'nearest' });
    const MouseEventConstructor = frameDocument.defaultView?.MouseEvent ?? MouseEvent;
    block.dispatchEvent(
      new MouseEventConstructor('click', {
        bubbles: true,
        cancelable: true,
      }),
    );
    return true;
  }, []);

  const selectNode = React.useCallback(
    (node: EventPageOutlineNode) => {
      outlineSelectionSourceRef.current = 'outline';
      setSelectedOutlineNodeId(node.id);
      dispatch({ type: 'setUi', ui: { itemSelector: { index: node.ownerIndex } } });
      if (node.selectableBlockId && selectCanvasBlock(node.selectableBlockId)) return;
      // Field-level outline rows select their owning canvas block, not every sibling field.
      if (node.ownerId && selectCanvasBlock(node.ownerId)) return;
    },
    [dispatch, selectCanvasBlock],
  );

  return (
    <ol className="space-y-1.5" data-testid="event-page-document-outline-tree">
      {nodes.map((node) => (
        <EventPageOutlineNodeView
          key={node.id}
          ancestorNodeIds={ancestorNodeIds}
          node={node}
          onSelectNode={selectNode}
          selectedNodeId={selectedNodeId}
        />
      ))}
    </ol>
  );
}

function EventPageOutlineNodeView({
  ancestorNodeIds,
  depth = 0,
  node,
  onSelectNode,
  selectedNodeId,
}: {
  ancestorNodeIds: Set<string>;
  depth?: number;
  node: EventPageOutlineNode;
  onSelectNode: (node: EventPageOutlineNode) => void;
  selectedNodeId?: string;
}) {
  const hasChildren = Boolean(node.children?.length);
  const selected = selectedNodeId === node.id;
  const isAncestor = !selected && ancestorNodeIds.has(node.id);
  const rowClassName = selected
    ? 'flex w-full min-w-0 items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-left text-sm text-accent-foreground'
    : isAncestor
      ? 'flex w-full min-w-0 items-center gap-2 rounded-md bg-accent/45 px-2 py-1.5 text-left text-sm text-foreground'
      : 'flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground';
  return (
    <li>
      <button
        aria-current={selected ? 'true' : undefined}
        className={rowClassName}
        data-outline-role={selected ? 'selected' : isAncestor ? 'ancestor' : 'idle'}
        onClick={() => onSelectNode(node)}
        style={{ paddingLeft: `${0.5 + depth * 1.1}rem` }}
        type="button"
      >
        <span className="shrink-0 text-pink-300">
          {node.icon ?? <LayoutTemplate className="size-3.5" />}
        </span>
        <span className="min-w-0 flex-1 truncate">{node.label}</span>
        {node.detail ? (
          <span className="max-w-24 shrink truncate text-[11px] text-muted-foreground/70">
            {node.detail}
          </span>
        ) : null}
      </button>
      {hasChildren ? (
        <ol className="space-y-1">
          {node.children?.map((child) => (
            <EventPageOutlineNodeView
              ancestorNodeIds={ancestorNodeIds}
              depth={depth + 1}
              key={child.id}
              node={child}
              onSelectNode={onSelectNode}
              selectedNodeId={selectedNodeId}
            />
          ))}
        </ol>
      ) : node.emptyLabel ? (
        <p
          className="px-2 py-1 text-sm text-muted-foreground/80"
          style={{ paddingLeft: `${1.85 + (depth + 1) * 1.1}rem` }}
        >
          {node.emptyLabel}
        </p>
      ) : null}
    </li>
  );
}

function listItemsFromResponse<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (!isRecord(value)) return [];
  if (Array.isArray(value.items)) return value.items as T[];
  return Object.values(value).filter(
    (item): item is T => Boolean(item) && typeof item === 'object',
  );
}

function resultMessage(error: { message?: string } | undefined, defaultMessage: string) {
  return error?.message ?? defaultMessage;
}

function latestVersion(items: AdminContentDocumentVersion[]) {
  return items.reduce<AdminContentDocumentVersion | undefined>(
    (current, version) =>
      !current || version.versionNumber > current.versionNumber ? version : current,
    undefined,
  );
}

function latestDraft(versions: AdminContentDocumentVersion[], document: AdminContentDocument) {
  return (
    versions.find((version) => version.id === document.currentDraftVersionId) ??
    latestVersion(versions.filter((version) => version.status === 'draft')) ??
    latestVersion(versions)
  );
}

function duplicateDocumentName(name: string): string {
  const suffix = ' Copy';
  return name.endsWith(suffix) ? name : `${name.slice(0, 160 - suffix.length)}${suffix}`;
}

function defaultDocumentInput(event: AdminEventDetail): CreateDefaultEventPageDocumentInput {
  const publicPath = `/e/${event.id}`;
  return {
    eventId: event.id,
    eventTitle: event.title,
    eventDescription: event.description ?? 'Hosted event page draft generated from event metadata.',
    startsAt: event.startsAt,
    endsAt: event.endsAt,
    timezone: event.timezone,
    venue: event.venue ?? {
      name: event.venueName,
      city: event.city,
    },
    coverImageUrl: event.coverImageUrl ?? undefined,
    coverImageAlt: event.title,
    publicUrl: publicPath,
    locale: 'en',
  };
}

function createDefaultDocument(event: AdminEventDetail): EventPageDocument {
  return createDefaultEventPageDocument(defaultDocumentInput(event));
}

function coerceStoredEventPageDocument(
  value: unknown,
  event: AdminEventDetail,
): EventPageDocument | undefined {
  const input = defaultDocumentInput(event);
  const normalized = normalizeEventPageDocument(value);
  if (normalized) return materializeEventPageDocument(normalized, input);
  if (!isRecord(value)) return undefined;
  if (!Array.isArray(value.blocks) && !isRecord(value.settings)) return undefined;
  return migrateLegacyEventPageDocumentToPuck(value as EventPageLegacyDocument, input);
}

function isPuckComponentData(value: unknown): value is EventPagePuckComponentData {
  return isRecord(value) && typeof value.type === 'string' && isRecord(value.props);
}

function coercePuckData(value: unknown, fallback: EventPagePuckData): EventPagePuckData {
  if (!isRecord(value) || !isRecord(value.root) || !Array.isArray(value.content)) return fallback;
  const rootProps = isRecord(value.root.props)
    ? (value.root.props as EventPagePuckData['root']['props'])
    : fallback.root.props;
  const zones = isRecord(value.zones)
    ? Object.fromEntries(
        Object.entries(value.zones).flatMap(([zoneName, zoneContent]) =>
          Array.isArray(zoneContent) ? [[zoneName, zoneContent.filter(isPuckComponentData)]] : [],
        ),
      )
    : undefined;
  return {
    root: { props: rootProps },
    content: value.content.filter(isPuckComponentData),
    ...(zones ? { zones } : {}),
  };
}

function firstEventHeader(document: EventPageDocument) {
  return document.editor.data.content.find((block) => block.type === 'EventHeader');
}

function firstEventDescription(document: EventPageDocument) {
  return document.editor.data.content.find((block) => block.type === 'EventDescription');
}

function eventPageSubject(document: EventPageDocument, event: AdminEventDetail): string {
  const header = firstEventHeader(document);
  const description = firstEventDescription(document);
  return (
    cleanString(document.settings.discovery.seoTitle) ??
    cleanString(document.editor.data.root.props.title) ??
    cleanString(header?.props.title) ??
    cleanString(description?.props.title) ??
    event.title
  );
}

function eventPagePreviewText(document: EventPageDocument, event: AdminEventDetail): string {
  const header = firstEventHeader(document);
  const description = firstEventDescription(document);
  return (
    cleanString(document.settings.discovery.seoDescription) ??
    cleanString(document.settings.discovery.summary) ??
    cleanString(document.editor.data.root.props.description) ??
    cleanString(description?.props.body) ??
    cleanString(header?.props.description) ??
    cleanString(event.description) ??
    `Details for ${event.title}.`
  );
}

function syncSettingsFromData(
  settings: EventPageSettings,
  data: EventPagePuckData,
  event: AdminEventDetail,
): EventPageSettings {
  const header = data.content.find((block) => block.type === 'EventHeader');
  const description = data.content.find((block) => block.type === 'EventDescription');
  const summary =
    cleanString(description?.props.body) ??
    cleanString(header?.props.description) ??
    cleanString(data.root.props.description) ??
    settings.discovery.summary;
  const title =
    cleanString(data.root.props.title) ??
    cleanString(header?.props.title) ??
    cleanString(description?.props.title) ??
    event.title;
  return {
    ...settings,
    discovery: {
      ...settings.discovery,
      summary,
      seoTitle: title,
      seoDescription: summary,
      coverImageUrl:
        cleanString(header?.props.imageUrl) ??
        cleanString(description?.props.imageUrl) ??
        settings.discovery.coverImageUrl,
      socialImageUrl:
        cleanString(header?.props.imageUrl) ??
        cleanString(description?.props.imageUrl) ??
        settings.discovery.socialImageUrl,
    },
  };
}

function withPuckData(
  document: EventPageDocument,
  data: unknown,
  event: AdminEventDetail,
): EventPageDocument {
  const puckData = coercePuckData(data, document.editor.data);
  return {
    ...document,
    editor: {
      provider: PUCK_EVENT_PAGE_PROVIDER,
      data: puckData,
    },
    settings: syncSettingsFromData(document.settings, puckData, event),
  };
}

function saveBodyForDocument(document: EventPageDocument, event: AdminEventDetail) {
  return {
    contentJson: document,
    subject: eventPageSubject(document, event),
    previewText: eventPagePreviewText(document, event),
  };
}

function publicPageUrl(_document: EventPageDocument, event: AdminEventDetail): string {
  // Always open the checkout-hosted public event page, not the admin origin.
  return publicEventUrl(event);
}

function PuckIframeOverride({
  children,
  document: previewDocument,
  runtime,
  brand,
}: {
  children: React.ReactNode;
  document?: Document | null;
  runtime: EventPageRuntime;
  brand?: AdminBrand;
}) {
  const dispatch = useEventPagePuck((state) => state.dispatch);

  React.useEffect(() => {
    if (!previewDocument) return;

    previewDocument.title = 'Event page editor canvas';
    previewDocument.documentElement.setAttribute('lang', 'en');

    const frame = previewDocument.defaultView?.frameElement;
    frame?.setAttribute('title', 'Event page editor canvas');
    frame?.setAttribute('aria-label', 'Event page editor canvas');
  }, [previewDocument]);

  React.useEffect(() => {
    if (!previewDocument) return;

    function handleHeroImageEdit(event: Event) {
      const detail = (event as CustomEvent).detail as
        | {
            id?: unknown;
            blockType?: unknown;
            placement?: { x?: unknown; y?: unknown; scale?: unknown };
            imageFit?: unknown;
          }
        | undefined;
      const id = typeof detail?.id === 'string' ? detail.id : undefined;
      if (!id) return;
      const blockType =
        detail?.blockType === 'EventHeader' || detail?.blockType === 'EventDescription'
          ? detail.blockType
          : 'EventDescription';

      const placement = detail?.placement;
      const nextPlacement = placement
        ? {
            x: typeof placement.x === 'string' ? placement.x : '50%',
            y: typeof placement.y === 'string' ? placement.y : '50%',
            scale: typeof placement.scale === 'string' ? placement.scale : '1',
          }
        : undefined;
      const nextImageFit =
        detail?.imageFit === 'cover' || detail?.imageFit === 'contain'
          ? detail.imageFit
          : undefined;
      if (!nextPlacement && !nextImageFit) return;

      dispatch({
        type: 'set',
        state: (state) => ({
          ...state,
          data: {
            ...state.data,
            content: state.data.content.map((block) =>
              block.type === blockType && block.props.id === id
                ? {
                    ...block,
                    props: {
                      ...block.props,
                      ...(nextPlacement
                        ? {
                            imagePlacement: nextPlacement,
                            imagePositionX: nextPlacement.x,
                            imagePositionY: nextPlacement.y,
                          }
                        : {}),
                      ...(nextImageFit ? { imageFit: nextImageFit } : {}),
                    },
                  }
                : block,
            ),
          },
        }),
      });
    }

    previewDocument.addEventListener('tixkit:event-page-hero-image-edit', handleHeroImageEdit);
    return () => {
      previewDocument.removeEventListener('tixkit:event-page-hero-image-edit', handleHeroImageEdit);
    };
  }, [dispatch, previewDocument]);

  return (
    <EventPageRuntimeProvider value={runtime}>
      <main
        aria-label="Event page editor canvas"
        className="bg-background text-foreground min-h-full"
        data-testid="puck-iframe-main"
        style={brandThemeStyleFromAdminBrand(brand)}
      >
        {children}
      </main>
    </EventPageRuntimeProvider>
  );
}

const useEventPagePuck = createUsePuck<Config>();

const structurePanelMinWidth = 260;
const structurePanelMaxWidth = 460;
const structurePanelDefaultWidth = 320;

function EventPageInspectorPanel() {
  return (
    <div
      className="tk-ep-inspector flex h-full min-h-0 w-[320px] flex-col border-l bg-background"
      data-testid="event-page-inspector"
    >
      <div className="sticky top-0 z-10 border-b bg-background/95 px-3 py-2 backdrop-blur">
        <div>
          <p className="text-sm font-semibold tracking-tight">Settings</p>
          <p className="text-[11px] text-muted-foreground">
            Edit the selected block or page styles.
          </p>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Puck.Fields />
      </div>
    </div>
  );
}

function EventPageStructurePanel({
  data,
  onClose,
  width,
}: {
  data: EventPagePuckData;
  onClose: () => void;
  width: number;
}) {
  return (
    <aside
      aria-label="Page structure"
      className="tk-ep-inspector flex h-full min-h-0 shrink-0 flex-col border-r bg-background"
      data-testid="event-page-structure-panel"
      style={{ width }}
    >
      <div className="sticky top-0 z-10 border-b bg-background/95 px-3 py-2 backdrop-blur">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-tight">Page structure</p>
            <p className="text-[11px] text-muted-foreground">Outline and heading checks.</p>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                aria-label="Close page structure"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                onClick={onClose}
                type="button"
              >
                <PanelLeftClose className="size-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="right">Close panel</TooltipContent>
          </Tooltip>
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        <section>
          <div className="space-y-2" data-testid="event-page-outline">
            <EventPageDocumentOutline data={data} />
          </div>
        </section>
      </div>
    </aside>
  );
}

function EventPageStructurePanelToggle({
  onToggle,
  open,
}: {
  onToggle: () => void;
  open: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          aria-label={open ? 'Hide page structure panel' : 'Show page structure panel'}
          aria-pressed={open}
          className={
            open
              ? 'inline-flex size-8 items-center justify-center rounded-md border border-foreground/20 bg-accent text-accent-foreground transition-colors'
              : 'inline-flex size-8 items-center justify-center rounded-md border border-transparent text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground'
          }
          onClick={onToggle}
          type="button"
        >
          <PanelLeftOpen className="size-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="right">
        {open ? 'Hide page structure' : 'Page structure'}
      </TooltipContent>
    </Tooltip>
  );
}

function SelectFirstPuckBlockOnMount({
  documentId,
  hasContent,
}: {
  documentId: string;
  hasContent: boolean;
}) {
  const selectedItem = useEventPagePuck((state) => state.selectedItem);
  const dispatch = useEventPagePuck((state) => state.dispatch);
  const selectedDocumentRef = React.useRef<string | undefined>(undefined);

  React.useEffect(() => {
    if (!hasContent || selectedItem || selectedDocumentRef.current === documentId) return;
    selectedDocumentRef.current = documentId;
    dispatch({ type: 'setUi', ui: { itemSelector: { index: 0 } } });
  }, [dispatch, documentId, hasContent, selectedItem]);

  return null;
}

function EventPagePuckComponentsButton({
  onCancelDrag,
  onCancelTargetChange,
}: {
  onCancelDrag: (data: EventPagePuckCoreData) => void;
  onCancelTargetChange: (active: boolean) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [cancelTargetActive, setCancelTargetActive] = React.useState(false);
  const appState = useEventPagePuck((state) => state.appState);
  const isDragging = appState.ui.isDragging;
  const dispatch = useEventPagePuck((state) => state.dispatch);
  const wasDraggingRef = React.useRef(false);
  const dragStartStateRef = React.useRef<typeof appState | undefined>(undefined);
  const shouldCancelDragRef = React.useRef(false);
  const cancelTargetActiveRef = React.useRef(false);

  React.useEffect(() => {
    if (!isDragging) return;

    function updateCancelTarget(event: MouseEvent | PointerEvent) {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const canvasFrame = document.querySelector('[data-testid="editor-canvas"] iframe');
      const canvasFrameRect = canvasFrame?.getBoundingClientRect();
      const pointerInsideCanvas = Boolean(
        canvasFrameRect &&
        event.clientX >= canvasFrameRect.left &&
        event.clientX <= canvasFrameRect.right &&
        event.clientY >= canvasFrameRect.top &&
        event.clientY <= canvasFrameRect.bottom,
      );
      const releasedOnCancelZone = Boolean(target?.closest('[data-event-page-drag-cancel-zone]'));
      const nextActive = releasedOnCancelZone || !pointerInsideCanvas;
      shouldCancelDragRef.current = nextActive;
      if (cancelTargetActiveRef.current !== nextActive) {
        cancelTargetActiveRef.current = nextActive;
        setCancelTargetActive(nextActive);
        onCancelTargetChange(nextActive);
      }
    }

    function handlePointerRelease(event: MouseEvent | PointerEvent) {
      updateCancelTarget(event);
    }

    document.addEventListener('pointermove', updateCancelTarget, true);
    document.addEventListener('mousemove', updateCancelTarget, true);
    document.addEventListener('pointerup', handlePointerRelease, true);
    document.addEventListener('mouseup', handlePointerRelease, true);

    return () => {
      document.removeEventListener('pointermove', updateCancelTarget, true);
      document.removeEventListener('mousemove', updateCancelTarget, true);
      document.removeEventListener('pointerup', handlePointerRelease, true);
      document.removeEventListener('mouseup', handlePointerRelease, true);
    };
  }, [isDragging, onCancelTargetChange]);

  React.useEffect(() => {
    if (!wasDraggingRef.current && isDragging) {
      dragStartStateRef.current =
        typeof structuredClone === 'function'
          ? structuredClone(appState)
          : JSON.parse(JSON.stringify(appState));
      shouldCancelDragRef.current = false;
      cancelTargetActiveRef.current = false;
      setCancelTargetActive(false);
      onCancelTargetChange(false);
    }

    if (wasDraggingRef.current && !isDragging) {
      if (shouldCancelDragRef.current && dragStartStateRef.current) {
        const dragStartState = dragStartStateRef.current;
        dispatch({
          type: 'set',
          state: () => ({
            ...dragStartState,
            ui: { ...dragStartState.ui, itemSelector: null, isDragging: false },
          }),
          recordHistory: false,
        });
        onCancelDrag(dragStartState.data as EventPagePuckCoreData);
      }
      dragStartStateRef.current = undefined;
      shouldCancelDragRef.current = false;
      cancelTargetActiveRef.current = false;
      setCancelTargetActive(false);
      onCancelTargetChange(false);
      setOpen(false);
    }
    wasDraggingRef.current = isDragging;
  }, [appState, dispatch, isDragging, onCancelDrag, onCancelTargetChange]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              aria-label="Add page section"
              className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-40"
              data-puck-dnd="event-page-add-section-cancel"
              data-puck-dnd-void
              type="button"
            >
              <Plus className="size-4" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="right">Add section</TooltipContent>
      </Tooltip>
      <PopoverContent
        align="start"
        className="max-h-[min(82svh,42rem)] w-[22rem] overflow-y-auto p-0"
        data-puck-dnd="event-page-add-section-popover-cancel"
        data-puck-dnd-void
        side="right"
        sideOffset={10}
      >
        <Drawer>
          <div
            className={[
              'space-y-3 p-3 text-popover-foreground',
              '[&_[class*="ComponentList-content"]]:pt-2',
              '[&_[class*="ComponentList-title"]]:rounded-md [&_[class*="ComponentList-title"]]:px-2 [&_[class*="ComponentList-title"]]:py-1.5 [&_[class*="ComponentList-title"]]:text-xs [&_[class*="ComponentList-title"]]:font-semibold [&_[class*="ComponentList-title"]]:uppercase [&_[class*="ComponentList-title"]]:tracking-normal [&_[class*="ComponentList-title"]]:text-muted-foreground [&_[class*="ComponentList-title"]]:hover:bg-muted/70',
              '[&_[class*="Drawer"]]:grid [&_[class*="Drawer"]]:grid-cols-1 [&_[class*="Drawer"]]:gap-2',
              '[&_[data-puck-drawer-item]]:w-full',
              isDragging && !cancelTargetActive
                ? 'rounded-md ring-2 ring-primary/40 ring-offset-2 ring-offset-background'
                : '',
              cancelTargetActive
                ? 'rounded-md ring-2 ring-destructive/70 ring-offset-2 ring-offset-background'
                : '',
            ].join(' ')}
            data-testid="event-page-puck-components"
          >
            <div className="flex items-center justify-between gap-3 border-b pb-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Plus className="size-4" />
                </span>
                <span className="truncate text-sm font-semibold">Add section</span>
              </div>
              {isDragging && (
                <span
                  className={[
                    'inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 text-xs font-medium transition-colors',
                    cancelTargetActive
                      ? 'border-destructive bg-destructive text-destructive-foreground'
                      : 'border-destructive/30 bg-destructive/10 text-destructive',
                  ].join(' ')}
                  data-event-page-drag-cancel-zone
                  data-state={cancelTargetActive ? 'active' : 'idle'}
                  data-testid="event-page-drag-cancel-zone"
                >
                  <XCircle className="size-3.5" />
                  {cancelTargetActive ? 'Release to cancel' : 'Move here to cancel'}
                </span>
              )}
            </div>
            <Puck.Components />
          </div>
        </Drawer>
      </PopoverContent>
    </Popover>
  );
}

function EventPagePuckDrawerItem({ name }: { children: React.ReactNode; name: string }) {
  return (
    <div className="flex w-full items-center gap-2.5 rounded-md border bg-background px-3 py-2.5 text-sm text-foreground shadow-xs">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {eventPageComponentIcon(name)}
      </span>
      <span className="min-w-0 flex-1 truncate">{eventPageComponentLabel(name)}</span>
      <GripVertical className="size-4 shrink-0 text-muted-foreground" />
    </div>
  );
}

function buildPageRuntime(input: EventPageEditorChrome): EventPageRuntime {
  const brand = input.brand;
  const ticketItems = input.tickets
    .filter((ticket) => ticket.visibility !== 'hidden')
    .map((ticket) => {
      const remaining =
        typeof ticket.quantityTotal === 'number'
          ? Math.max(ticket.quantityTotal - ticket.quantitySold, 0)
          : undefined;
      const soldOut =
        ticket.status === 'sold_out' ||
        ticket.status === 'ended' ||
        (typeof remaining === 'number' && remaining <= 0);
      return {
        id: ticket.id,
        name: ticket.name,
        description: ticket.description,
        priceLabel: ticketPriceLabel({
          kind: ticket.kind,
          priceCents: ticket.priceCents,
          currency: ticket.currency,
          minimumPriceCents: ticket.minimumPriceCents,
        }),
        status: soldOut ? 'sold_out' : 'active',
        availabilityLabel:
          !soldOut && typeof remaining === 'number' && remaining <= 10
            ? `${remaining} left`
            : undefined,
      };
    });
  const productItems = input.products
    .filter((product) => product.status === 'active')
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
    .map((product) => ({
      id: product.id,
      name: product.name,
      description: product.description,
      priceLabel: ticketPriceLabel({
        kind: 'product',
        priceCents: product.priceCents,
        currency: product.currency,
      }),
      status: 'active',
    }));
  const tickets = [...ticketItems, ...productItems];

  const footerLinks = [
    brand?.legalUrls.terms ? { label: 'Terms', href: brand.legalUrls.terms } : null,
    brand?.legalUrls.privacy ? { label: 'Privacy', href: brand.legalUrls.privacy } : null,
    brand?.legalUrls.refundPolicy
      ? { label: 'Refund policy', href: brand.legalUrls.refundPolicy }
      : null,
    brand?.supportUrl ? { label: 'Support', href: brand.supportUrl } : null,
  ].filter((link): link is { label: string; href: string } => Boolean(link));

  return {
    brandName: brand?.name ?? 'Event',
    brandFooterLabel: brand?.whiteLabel
      ? (brand.name ?? 'Event')
      : brand?.name
        ? `${brand.name} · Powered by Tixkit`
        : 'Powered by Tixkit',
    footerLinks,
    tickets,
    resaleListings: [],
    showGetTicketsCta: tickets.some((ticket) => ticket.status === 'active'),
    interactive: false,
  };
}

function brandVariablesFromAdminBrand(brand?: AdminBrand) {
  const theme = brand?.theme ?? {};
  return {
    background: typeof theme.background === 'string' ? theme.background : undefined,
    foreground: typeof theme.foreground === 'string' ? theme.foreground : undefined,
    accent:
      typeof theme.primaryColor === 'string'
        ? theme.primaryColor
        : typeof theme.primary === 'string'
          ? theme.primary
          : typeof theme.accent === 'string'
            ? theme.accent
            : undefined,
    radius: typeof theme.radius === 'string' ? theme.radius : undefined,
  };
}

/** Map admin brand theme tokens onto checkout/shadcn CSS variables for exact chrome styling. */
function brandThemeStyleFromAdminBrand(brand?: AdminBrand): React.CSSProperties | undefined {
  const theme = brand?.theme ?? {};
  const style: Record<string, string> = {};
  for (const [key, value] of Object.entries(theme)) {
    if (typeof value !== 'string' || !value) continue;
    const tokenKey = key === 'primaryColor' ? 'primary' : key;
    const cssKey = tokenKey.startsWith('--') ? tokenKey : `--${tokenKey}`;
    style[cssKey] = value;
  }
  return Object.keys(style).length > 0 ? (style as React.CSSProperties) : undefined;
}

function puckOverrides(runtime: EventPageRuntime, brand?: AdminBrand): Partial<Overrides<Config>> {
  return {
    drawerItem: EventPagePuckDrawerItem,
    header: ({ actions }: { actions: React.ReactNode }) => (
      <div className="border-b bg-background px-3 py-2">
        <div className="flex items-center justify-end gap-2">{actions}</div>
      </div>
    ),
    headerActions: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    fields: ({ children, isLoading }: { children: React.ReactNode; isLoading: boolean }) => (
      <div className="tk-ep-fields h-full overflow-y-auto px-3 py-3">
        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading fields...</p>
        ) : (
          <div className="tk-ep-fields__list space-y-3">{children}</div>
        )}
      </div>
    ),
    drawer: ({ children }: { children: React.ReactNode }) => (
      <div className="h-full overflow-y-auto border-r bg-background p-3">{children}</div>
    ),
    iframe: ({
      children,
      document: previewDocument,
    }: {
      children: React.ReactNode;
      document?: Document | null;
    }) => (
      <PuckIframeOverride brand={brand} document={previewDocument} runtime={runtime}>
        {children}
      </PuckIframeOverride>
    ),
    preview: ({ children }: { children: React.ReactNode }) => (
      <div
        className="bg-background text-foreground min-h-full"
        data-testid="editor-public-page-surface"
        style={brandThemeStyleFromAdminBrand(brand)}
      >
        <div data-testid="preview-surface">{children}</div>
      </div>
    ),
  };
}

function PreviewDrawer({
  brand,
  runtime,
  onClose,
  preview,
}: {
  brand?: AdminBrand;
  runtime: EventPageRuntime;
  onClose: () => void;
  preview: EventPagePreview;
}) {
  const [tab, setTab] = React.useState<'rendered' | 'issues' | 'json'>('rendered');
  return (
    <aside
      aria-label="Event page preview"
      className="fixed inset-y-0 right-0 z-50 flex w-full max-w-xl flex-col border-l bg-background text-foreground shadow-2xl"
      data-testid="preview-drawer"
    >
      <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
        <div>
          <p className="text-sm font-semibold">{preview.label}</p>
          <p className="text-xs text-muted-foreground">
            {preview.validation.valid ? 'Valid public page draft' : 'Publish blockers'}
          </p>
        </div>
        <button
          className="rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
      <div className="flex gap-1 border-b px-4 py-2">
        {(['rendered', 'issues', 'json'] as const).map((item) => (
          <button
            aria-pressed={tab === item}
            className={`rounded-md px-3 py-1 text-xs transition-colors ${
              tab === item
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent'
            }`}
            key={item}
            onClick={() => setTab(item)}
            type="button"
          >
            {item === 'rendered' ? 'Rendered' : item === 'issues' ? 'Issues' : 'JSON'}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {tab === 'rendered' && (
          <div
            className="bg-background text-foreground min-h-full"
            data-testid="preview-public-page-surface"
            style={brandThemeStyleFromAdminBrand(brand)}
          >
            <EventPageRender
              brandVariables={brandVariablesFromAdminBrand(brand)}
              document={preview.document}
              runtime={runtime}
              validate={false}
            />
          </div>
        )}
        {tab === 'issues' && (
          <div className="space-y-3 p-4 text-sm">
            {preview.validation.issues.length === 0 ? (
              <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-emerald-700">
                No Puck document blockers.
              </p>
            ) : (
              preview.validation.issues.map((issue) => (
                <p
                  className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-destructive"
                  key={`${issue.code}:${issue.field ?? ''}`}
                >
                  {issue.message}
                </p>
              ))
            )}
          </div>
        )}
        {tab === 'json' && (
          <pre className="m-4 whitespace-pre-wrap rounded-md border bg-muted/30 p-4 text-xs leading-5">
            {JSON.stringify(preview.document, null, 2)}
          </pre>
        )}
      </div>
    </aside>
  );
}

export function EventPagePersistedEditorView({ eventId }: { eventId: string }) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [eventPageDocument, setEventPageDocument] = React.useState<EventPageDocument>();
  const [editorChrome, setEditorChrome] = React.useState<EventPageEditorChrome>({
    tickets: [],
    products: [],
  });
  const [structurePanelOpen, setStructurePanelOpen] = React.useState(true);
  const [structurePanelWidth, setStructurePanelWidth] = React.useState(structurePanelDefaultWidth);
  const [editorMode, setEditorMode] = React.useState<EditorMode>('editor');
  const [puckEditorResetKey, setPuckEditorResetKey] = React.useState(0);
  const [cancelDropTargetActive, setCancelDropTargetActive] = React.useState(false);
  const [preview, setPreview] = React.useState<EventPagePreview>();
  const [previewOpen, setPreviewOpen] = React.useState(false);
  const [autosave, setAutosave] = React.useState<AutosaveState>('idle');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [actionError, setActionError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const operationIdRef = React.useRef(0);
  const { can } = usePermissions();
  const isArchived = document?.status === 'archived';
  const canEdit = !isArchived && can('events.write');
  const pageRuntime = React.useMemo(() => buildPageRuntime(editorChrome), [editorChrome]);
  const hasCommerceItems = pageRuntime.tickets.length > 0;
  const overrides = React.useMemo(
    () => puckOverrides(pageRuntime, editorChrome.brand),
    [editorChrome.brand, pageRuntime],
  );
  const uploadEventPageImage = React.useCallback<EventPagePuckUploadImage>(
    async (file) => {
      if (!event?.brandId || !event.id) {
        throw new Error('Event page image uploads require an event and brand context.');
      }
      const result = await adminApi.uploadArtifact({
        purpose: 'content_event_page_image',
        file,
        brandId: event.brandId,
        eventId: event.id,
        metadata: {
          source: 'admin_event_page_editor',
          contentDocumentId: document?.id,
        },
      });
      if (!result.ok) {
        throw new Error(resultMessage(result.error, 'Unable to upload event page image'));
      }
      if (!result.data.downloadUrl) {
        throw new Error('Uploaded event page image did not return a download URL.');
      }
      return { url: result.data.downloadUrl };
    },
    [document?.id, event?.brandId, event?.id],
  );
  const puckConfig = React.useMemo(
    () => createEventPagePuckConfig({ hasCommerceItems, onUploadImage: uploadEventPageImage }),
    [hasCommerceItems, uploadEventPageImage],
  );

  React.useEffect(() => {
    const frame = window.document.querySelector<HTMLIFrameElement>(
      '[data-testid="editor-canvas"] iframe',
    );
    const frameDocument = frame?.contentDocument;
    const previousPointerEvents = frame?.style.pointerEvents ?? '';
    const existingStyle = frameDocument?.getElementById(cancelDropIframeStyleId);

    if (!cancelDropTargetActive || !frame || !frameDocument?.head) {
      existingStyle?.remove();
      if (frame) frame.style.pointerEvents = previousPointerEvents;
      return undefined;
    }

    frame.style.pointerEvents = 'none';
    const style = existingStyle ?? frameDocument.createElement('style');
    style.id = cancelDropIframeStyleId;
    style.textContent = `
      [data-dnd-placeholder] {
        display: none !important;
        height: 0 !important;
        min-height: 0 !important;
        margin: 0 !important;
        padding: 0 !important;
        opacity: 0 !important;
        pointer-events: none !important;
      }

      [data-puck-dropzone],
      [data-puck-dnd] {
        outline-color: transparent !important;
      }
    `;
    if (!existingStyle) {
      frameDocument.head.append(style);
    }

    return () => {
      style.remove();
      frame.style.pointerEvents = previousPointerEvents;
    };
  }, [cancelDropTargetActive]);

  function nextOperationId() {
    operationIdRef.current += 1;
    return operationIdRef.current;
  }

  function isCurrentOperation(operationId: number) {
    return operationIdRef.current === operationId;
  }

  function markDraftDirty() {
    if (isArchived) return;
    nextOperationId();
    setAutosave('idle');
    setActionError(undefined);
    setNotice(undefined);
  }

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(undefined);
    setActionError(undefined);
    setNotice(undefined);

    const eventResult = await adminApi.getEvent(eventId);
    if (!eventResult.ok) {
      setError(resultMessage(eventResult.error, 'Unable to load event'));
      setLoading(false);
      return;
    }
    const loadedEvent = eventResult.data;
    if (!loadedEvent.organizationId || !loadedEvent.brandId) {
      setError('Event is missing organization or brand scope for persisted event-page content.');
      setLoading(false);
      return;
    }

    const documentsResult = await adminApi.listContentDocuments({
      channel: 'event_page',
      brandId: loadedEvent.brandId,
      eventId: loadedEvent.id,
      limit: 20,
    });
    if (!documentsResult.ok) {
      setError(resultMessage(documentsResult.error, 'Unable to load event page content documents'));
      setLoading(false);
      return;
    }

    const documents = listItemsFromResponse<AdminContentDocument>(documentsResult.data);
    let loadedDocument = documents.find(
      (item) => item.channel === 'event_page' && item.eventId === loadedEvent.id,
    );
    if (!loadedDocument) {
      const createResult = await adminApi.createContentDocument({
        organizationId: loadedEvent.organizationId,
        brandId: loadedEvent.brandId,
        eventId: loadedEvent.id,
        channel: 'event_page',
        key: 'main',
        name: `${loadedEvent.title} event page`,
        locale: 'en',
      });
      if (!createResult.ok) {
        setError(resultMessage(createResult.error, 'Unable to create event page content document'));
        setLoading(false);
        return;
      }
      loadedDocument = createResult.data;
    }

    const versionsResult = await adminApi.listContentVersions(loadedDocument.id);
    if (!versionsResult.ok) {
      setError(resultMessage(versionsResult.error, 'Unable to load event page versions'));
      setLoading(false);
      return;
    }

    let loadedVersions = listItemsFromResponse<AdminContentDocumentVersion>(versionsResult.data);
    let loadedDraft = latestDraft(loadedVersions, loadedDocument);
    if (!loadedDraft) {
      const initialDocument = createDefaultDocument(loadedEvent);
      const saveResult = await adminApi.saveContentVersion(
        loadedDocument.id,
        saveBodyForDocument(initialDocument, loadedEvent),
      );
      if (!saveResult.ok) {
        setError(resultMessage(saveResult.error, 'Unable to create the initial event page draft'));
        setLoading(false);
        return;
      }
      loadedDraft = saveResult.data;
      loadedVersions = [saveResult.data];
    }

    const normalized = coerceStoredEventPageDocument(loadedDraft.contentJson, loadedEvent);
    if (!normalized) {
      setError('Saved event page draft is not a schemaVersion 2 Puck document.');
      setLoading(false);
      return;
    }

    const [brandsResult, ticketsResult, productsResult] = await Promise.all([
      adminApi.listBrands(),
      adminApi.listTicketTypes(loadedEvent.id),
      adminApi.listProducts(loadedEvent.id),
    ]);
    const brands = brandsResult.ok
      ? Array.isArray(brandsResult.data)
        ? brandsResult.data
        : listItemsFromResponse<AdminBrand>(brandsResult.data)
      : [];
    const tickets = ticketsResult.ok
      ? Array.isArray(ticketsResult.data)
        ? ticketsResult.data
        : listItemsFromResponse<AdminTicketType>(ticketsResult.data)
      : [];
    const products = productsResult.ok
      ? Array.isArray(productsResult.data)
        ? productsResult.data
        : listItemsFromResponse<AdminProduct>(productsResult.data)
      : [];

    setEvent(loadedEvent);
    setDocument(loadedDocument);
    setDraft(loadedDraft);
    setEventPageDocument(normalized);
    setEditorChrome({
      brand: brands.find((item) => item.id === loadedEvent.brandId),
      tickets,
      products,
      title: loadedEvent.title,
      description: loadedEvent.description ?? undefined,
      startsAt: loadedEvent.startsAt,
      timezone: loadedEvent.timezone,
      venueName: loadedEvent.venue?.name ?? loadedEvent.venueName ?? undefined,
    });
    setPreview({
      label: 'Current Puck draft',
      document: normalized,
      validation: validateEventPageDocument(normalized),
    });
    setAutosave('saved');
    setLoading(false);
  }, [eventId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function saveDraft(operationId = nextOperationId(), snapshot = eventPageDocument) {
    if (!document || !event || !snapshot || isArchived) return undefined;
    setAutosave('saving');
    const result = await adminApi.saveContentVersion(
      document.id,
      saveBodyForDocument(snapshot, event),
    );
    if (!isCurrentOperation(operationId)) return undefined;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to save event page draft'));
      return undefined;
    }
    setDraft(result.data);
    setPreview({
      label: `Saved draft v${result.data.versionNumber}`,
      document: snapshot,
      validation: validateEventPageDocument(snapshot),
    });
    setAutosave('saved');
    setActionError(undefined);
    setNotice(`Saved draft v${result.data.versionNumber}`);
    return { version: result.data, document: snapshot };
  }

  async function previewSavedDraft() {
    if (!eventPageDocument || isArchived) return;
    const operationId = nextOperationId();
    const snapshot = eventPageDocument;
    const saved = await saveDraft(operationId, snapshot);
    if (!saved || !isCurrentOperation(operationId)) return;
    setPreview({
      label: `Saved draft v${saved.version.versionNumber}`,
      document: saved.document,
      validation: validateEventPageDocument(saved.document),
    });
    setPreviewOpen(true);
    setActionError(undefined);
    setNotice('Preview opened from the saved Puck document');
  }

  async function publishDraft(snapshot = eventPageDocument) {
    if (!document || !snapshot || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, snapshot);
    if (!saved) return;
    const result = await adminApi.publishContentVersion(document.id, saved.version.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to publish event page'));
      return;
    }
    setDocument(result.data.document);
    setDraft(result.data.version);
    setActionError(undefined);
    setNotice(`Published v${result.data.version.versionNumber}`);
    toast.success('Event page published');
  }

  async function archiveDocument() {
    if (!document) return;
    if (
      !window.confirm(
        'Archive this event page? Editing, publishing, and previews will be disabled.',
      )
    ) {
      return;
    }
    const operationId = nextOperationId();
    const result = await adminApi.archiveContentDocument(document.id);
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to archive event page'));
      return;
    }
    setDocument(result.data);
    setActionError(undefined);
    setNotice('Archived event page');
    toast.success('Event page archived');
  }

  async function duplicateDocument() {
    if (!document || !eventPageDocument || isArchived) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, eventPageDocument);
    if (!saved) return;
    const result = await adminApi.duplicateContentDocument(document.id, {
      name: duplicateDocumentName(document.name),
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
      setAutosave('error');
      setActionError(resultMessage(result.error, 'Unable to duplicate event page'));
      return;
    }
    setActionError(undefined);
    setNotice(`Duplicated event page as ${result.data.name}`);
    toast.success('Event page duplicated');
  }

  function viewPublicPage() {
    if (!event || !eventPageDocument || isArchived) return;
    const url = publicPageUrl(eventPageDocument, event);
    window.open(url, '_blank', 'noopener,noreferrer');
    setActionError(undefined);
    setNotice('Opened public page');
  }

  function setCurrentPuckData(data: unknown, options: { markDirty?: boolean } = {}) {
    if (!event || !eventPageDocument || isArchived) return;
    const { markDirty = true } = options;
    const nextDocument = withPuckData(eventPageDocument, data, event);
    setEventPageDocument(nextDocument);
    setPreview({
      label: 'Current Puck draft',
      document: nextDocument,
      validation: validateEventPageDocument(nextDocument),
    });
    if (markDirty) {
      markDraftDirty();
    }
  }

  function cancelPuckDrag(data: EventPagePuckCoreData) {
    setCurrentPuckData(data, { markDirty: false });
    setPuckEditorResetKey((key) => key + 1);
  }

  function startStructurePanelResize(pointerEvent: React.PointerEvent<HTMLButtonElement>) {
    pointerEvent.preventDefault();
    const startX = pointerEvent.clientX;
    const startWidth = structurePanelWidth;
    const resizeHandle = pointerEvent.currentTarget;
    const pointerId = pointerEvent.pointerId;
    resizeHandle.setPointerCapture(pointerId);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const nextWidth = Math.min(
        structurePanelMaxWidth,
        Math.max(structurePanelMinWidth, startWidth + moveEvent.clientX - startX),
      );
      setStructurePanelWidth(nextWidth);
    };

    const stopResize = () => {
      if (resizeHandle.hasPointerCapture(pointerId)) {
        resizeHandle.releasePointerCapture(pointerId);
      }
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }

  if (loading) {
    return (
      <div className="flex min-h-svh items-center justify-center bg-background text-sm text-muted-foreground">
        Loading Puck event-page editor...
      </div>
    );
  }

  if (error || !event || !document || !draft || !eventPageDocument || !preview) {
    return (
      <section className="flex min-h-svh items-center justify-center bg-background p-6 text-foreground">
        <div className="w-full max-w-lg space-y-4 rounded-lg border bg-card p-6 text-card-foreground">
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">Event page editor</p>
            <h1 className="text-2xl font-semibold">Unable to load editor</h1>
          </div>
          <p className="text-sm text-destructive">
            {error ?? 'Hosted page editor could not load.'}
          </p>
          <button
            className="rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent"
            onClick={() => void load()}
            type="button"
          >
            Retry
          </button>
        </div>
      </section>
    );
  }

  const archivedReason = isArchived ? 'Archived pages are read-only.' : undefined;
  const localValidation = validateEventPageDocument(eventPageDocument);
  const publishDisabled =
    Boolean(archivedReason) || autosave === 'saving' || !localValidation.valid;
  const permissions: Partial<Permissions> = {
    delete: canEdit,
    drag: canEdit,
    duplicate: canEdit,
    edit: canEdit,
    insert: canEdit,
  };
  const moreActionsItems: DropdownMenuItemConfig[] = [
    {
      id: 'save',
      label: 'Save draft',
      icon: <Save className="size-4" />,
      onClick: () => void saveDraft(),
      disabled: Boolean(archivedReason) || autosave === 'saving',
      separatorAfter: true,
    },
    {
      id: 'preview',
      label: 'Open preview',
      icon: <Eye className="size-4" />,
      onClick: () => void previewSavedDraft(),
      disabled: Boolean(archivedReason) || autosave === 'saving',
    },
    {
      id: 'public',
      label: 'View public page',
      icon: <ExternalLink className="size-4" />,
      onClick: () => viewPublicPage(),
      disabled: Boolean(archivedReason),
    },
    {
      id: 'duplicate',
      label: 'Duplicate page',
      icon: <Copy className="size-4" />,
      onClick: () => void duplicateDocument(),
      disabled: Boolean(archivedReason),
      separatorAfter: true,
    },
    {
      id: 'archive',
      label: 'Archive page',
      icon: <Archive className="size-4" />,
      onClick: () => void archiveDocument(),
      destructive: true,
    },
  ];

  const handleModeChange = (mode: EditorMode) => {
    setEditorMode(mode);
    if (mode === 'preview') void previewSavedDraft();
  };

  const editorCanvas = (
    <main
      aria-label="Event page editable document"
      className="min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/30"
      data-testid="editor-canvas"
    >
      <div className="flex h-full min-h-0 overflow-hidden">
        {structurePanelOpen && (
          <>
            <EventPageStructurePanel
              data={eventPageDocument.editor.data}
              onClose={() => setStructurePanelOpen(false)}
              width={structurePanelWidth}
            />
            <button
              aria-label="Resize page structure"
              className="group flex h-full w-2 shrink-0 cursor-col-resize items-center justify-center border-r bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              onPointerDown={startStructurePanelResize}
              type="button"
            >
              <GripVertical className="size-3.5 opacity-55 transition-opacity group-hover:opacity-100" />
            </button>
          </>
        )}
        <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
          <Puck.Preview />
        </div>
        <EventPageInspectorPanel />
      </div>
    </main>
  );

  const previewCanvas = (
    <main
      aria-label="Event page editable document"
      className="min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/30"
      data-testid="editor-canvas"
    >
      <div className="h-full overflow-auto">
        <div
          className="bg-background text-foreground min-h-full"
          data-testid="preview-mode-public-page-surface"
          style={brandThemeStyleFromAdminBrand(editorChrome.brand)}
        >
          <EventPageRender
            brandVariables={brandVariablesFromAdminBrand(editorChrome.brand)}
            document={eventPageDocument}
            runtime={pageRuntime}
            validate={false}
          />
        </div>
      </div>
    </main>
  );

  const codeCanvas = (
    <main
      aria-label="Event page editable document"
      className="min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/30"
      data-testid="editor-canvas"
    >
      <div className="h-full overflow-auto p-5">
        <pre className="rounded-md border bg-background p-4 text-xs leading-5">
          {JSON.stringify(eventPageDocument, null, 2)}
        </pre>
      </div>
    </main>
  );

  const canvas =
    editorMode === 'editor' ? editorCanvas : editorMode === 'preview' ? previewCanvas : codeCanvas;

  const topBar = (
    <EditorTopBar
      autosave={autosave}
      backHref={`/events/${event.id}`}
      channelLabel="Page"
      documentName={document.name}
      error={actionError}
      moreActions={moreActionsItems}
      notice={notice}
      onPublish={() => void publishDraft()}
      publishDisabled={publishDisabled}
      status={document.status}
    />
  );

  const renderChrome = (inserts: React.ReactNode, insertsDisabled = false) => (
    <EditorChrome
      channel="event-page"
      testId="content-editor-shell"
      topBar={topBar}
      leftRail={
        <EditorLeftRail
          hiddenModes={{}}
          inserts={
            <>
              <EventPageStructurePanelToggle
                onToggle={() => setStructurePanelOpen((open) => !open)}
                open={structurePanelOpen}
              />
              {inserts}
            </>
          }
          insertsDisabled={insertsDisabled}
          mode={editorMode}
          onModeChange={handleModeChange}
        />
      }
      canvas={canvas}
      inspector={null}
    />
  );

  return (
    <>
      {editorMode === 'editor' ? (
        <Puck
          config={puckConfig}
          data={eventPageDocument.editor.data as EventPagePuckCoreData}
          height="100svh"
          iframe={eventPagePuckIframeConfig}
          key={`${document.id}:${puckEditorResetKey}`}
          onChange={(data) => setCurrentPuckData(data)}
          onPublish={(data) => {
            if (!eventPageDocument || !event) return;
            const nextDocument = withPuckData(eventPageDocument, data, event);
            setEventPageDocument(nextDocument);
            void publishDraft(nextDocument);
          }}
          overrides={overrides}
          permissions={permissions}
          viewports={eventPageViewports}
        >
          <SelectFirstPuckBlockOnMount
            documentId={document.id}
            hasContent={eventPageDocument.editor.data.content.length > 0}
          />
          {renderChrome(
            <EventPagePuckComponentsButton
              onCancelDrag={cancelPuckDrag}
              onCancelTargetChange={setCancelDropTargetActive}
            />,
            !canEdit,
          )}
        </Puck>
      ) : (
        renderChrome(<span className="sr-only">Puck components are available in the canvas.</span>)
      )}
      {previewOpen && preview && (
        <PreviewDrawer
          brand={editorChrome.brand}
          onClose={() => setPreviewOpen(false)}
          preview={preview}
          runtime={pageRuntime}
        />
      )}
      {archivedReason && (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground shadow-sm">
          {archivedReason}
        </div>
      )}
    </>
  );
}
