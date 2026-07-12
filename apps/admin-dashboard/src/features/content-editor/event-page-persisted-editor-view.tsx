'use client';

import * as React from 'react';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
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
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Plus,
  Save,
  Search,
  Settings2,
  Share2,
  Smartphone,
  Tablet,
  Type,
  Users,
  X,
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
  EVENT_PAGE_PUCK_COMPONENT_TYPES,
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
type EventPageNavigatorTab = 'sections' | 'add';
type EventPageMobilePanel = EventPageNavigatorTab | 'settings' | null;
type EventPagePreviewViewport = 'desktop' | 'tablet' | 'mobile';
type EventPageFocusTarget = number | 'root' | null;

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
const eventPagePuckComponentTypeSet = new Set<string>(EVENT_PAGE_PUCK_COMPONENT_TYPES);

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
  ProductAddOns: 'Product add-ons',
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
    case 'ProductAddOns':
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
  canvasTargetId?: string;
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
): EventPageOutlineNode | undefined {
  const props = block.props as Record<string, unknown>;
  const slotChildren = [
    ...outlineSlotItems(props[slotName]),
    ...outlineZoneItems(data, block, slotName),
  ];
  if (slotChildren.length === 0) return undefined;
  const preserveRootOwnerIndex = (node: EventPageOutlineNode): EventPageOutlineNode => ({
    ...node,
    ownerIndex,
    children: node.children?.map(preserveRootOwnerIndex),
  });
  return {
    id: `${block.props.id}:${slotName}`,
    label,
    ownerIndex,
    ownerId,
    canvasTargetId: `${ownerId}:${slotName}`,
    icon: <LayoutTemplate className="size-3.5" />,
    children: slotChildren.map((child, index) =>
      preserveRootOwnerIndex(outlineNodeForBlock(data, child, index)),
    ),
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
    canvasTargetId: `${parentId}:${label}`,
    icon: <ListChecks className="size-3.5" />,
    children: items.map((item, index) => ({
      id: `${parentId}:${label}:${index}`,
      label:
        summaryKeys.map((key) => cleanString(item[key])).find(Boolean) ??
        `${label.replace(/s$/, '')} ${index + 1}`,
      ownerIndex,
      ownerId,
      canvasTargetId: `${parentId}:${label}:${index}`,
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

function clearCanvasOutlineTargets(frameDocument: Document) {
  frameDocument
    .querySelectorAll('[data-event-page-outline-selected="true"]')
    .forEach((element) => element.removeAttribute('data-event-page-outline-selected'));
}

function clearEditorCanvasOutlineTargets() {
  const frame = window.document.querySelector<HTMLIFrameElement>(
    '[data-testid="editor-canvas"] iframe',
  );
  const frameDocument = frame?.contentDocument;
  if (frameDocument) clearCanvasOutlineTargets(frameDocument);
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
    options: {
      detail?: string;
      icon?: React.ReactNode;
      canvasTargetId?: string;
    } = {},
  ) => {
    children.push({
      id: `${id}:${key}`,
      label,
      detail: options.detail,
      ownerIndex,
      ownerId,
      canvasTargetId: options.canvasTargetId ?? `${id}:${key}`,
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
        addChild('description', 'Description copy', {
          detail: outlineText(props.description),
        });
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
      const overlayNode = outlineSlotNode(
        data,
        block,
        ownerIndex,
        ownerId,
        'imageOverlay',
        'Extra overlay content',
        'No items',
      );
      if (overlayNode) children.push(overlayNode);
      break;
    }
    case 'RichText':
      addChild('body', 'Rich text body', {
        detail: outlineText(props.body, 'Empty'),
      });
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
      if (props.overlayEnabled === true) {
        const overlayNode = outlineSlotNode(
          data,
          block,
          ownerIndex,
          ownerId,
          'imageOverlay',
          'Overlay blocks',
          'No items',
        );
        if (overlayNode) children.push(overlayNode);
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
        addChild('venue', 'Venue name', {
          detail: outlineText(props.venueName),
        });
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
        addChild('url', 'Button link', {
          detail: outlineText(props.url),
          canvasTargetId: `${id}:label`,
        });
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
      addChild('ticketList', 'Ticket list', {
        detail: outlineText(props.previewState, 'live'),
      });
      break;
    case 'ResaleTickets':
      addChild('title', 'H2 title', {
        detail: outlineText(props.title),
        icon: <Heading1 className="size-3.5" />,
      });
      addChild('resaleList', 'Resale list', {
        detail: outlineText(props.previewState, 'live'),
      });
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

function EventPageDocumentOutline({
  data,
  onNavigate,
}: {
  data: EventPagePuckData;
  onNavigate?: () => void;
}) {
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
      clearEditorCanvasOutlineTargets();
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
    clearCanvasOutlineTargets(frameDocument);
    block.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
      inline: 'nearest',
    });
    const MouseEventConstructor = frameDocument.defaultView?.MouseEvent ?? MouseEvent;
    block.dispatchEvent(
      new MouseEventConstructor('click', {
        bubbles: true,
        cancelable: true,
      }),
    );
    return true;
  }, []);

  const selectCanvasTarget = React.useCallback((targetId: string) => {
    const frame = window.document.querySelector<HTMLIFrameElement>(
      '[data-testid="editor-canvas"] iframe',
    );
    const frameDocument = frame?.contentDocument;
    if (!frameDocument) return false;
    const target = frameDocument.querySelector<HTMLElement>(
      `[data-event-page-outline-target="${escapeAttributeValue(targetId)}"]`,
    );
    if (!target) return false;
    clearCanvasOutlineTargets(frameDocument);
    target.setAttribute('data-event-page-outline-selected', 'true');
    target.scrollIntoView({
      behavior: 'auto',
      block: 'nearest',
      inline: 'nearest',
    });
    return true;
  }, []);

  const selectNode = React.useCallback(
    (node: EventPageOutlineNode) => {
      outlineSelectionSourceRef.current = 'outline';
      setSelectedOutlineNodeId(node.id);
      dispatch({
        type: 'setUi',
        ui: { itemSelector: { index: node.ownerIndex } },
      });
      if (node.canvasTargetId && selectCanvasTarget(node.canvasTargetId)) {
        onNavigate?.();
        return;
      }
      if (node.selectableBlockId && selectCanvasBlock(node.selectableBlockId)) {
        onNavigate?.();
        return;
      }
      // Field-level outline rows select their owning canvas block, not every sibling field.
      if (node.ownerId && selectCanvasBlock(node.ownerId)) {
        onNavigate?.();
        return;
      }
      onNavigate?.();
    },
    [dispatch, onNavigate, selectCanvasBlock, selectCanvasTarget],
  );

  const moveNode = React.useCallback(
    (node: EventPageOutlineNode, destinationIndex: number) => {
      dispatch({
        type: 'reorder',
        sourceIndex: node.ownerIndex,
        destinationIndex,
        destinationZone: 'root:default-zone',
      });
      dispatch({
        type: 'setUi',
        ui: {
          itemSelector: { index: destinationIndex, zone: 'root:default-zone' },
        },
      });
    },
    [dispatch],
  );

  return (
    <ol className="space-y-1.5" data-testid="event-page-document-outline-tree">
      {nodes.map((node) => (
        <EventPageOutlineNodeView
          key={node.id}
          ancestorNodeIds={ancestorNodeIds}
          node={node}
          onMoveNode={moveNode}
          onSelectNode={selectNode}
          rootIndex={node.ownerIndex}
          rootNodeCount={nodes.length}
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
  onMoveNode,
  onSelectNode,
  rootIndex,
  rootNodeCount,
  selectedNodeId,
}: {
  ancestorNodeIds: Set<string>;
  depth?: number;
  node: EventPageOutlineNode;
  onMoveNode?: (node: EventPageOutlineNode, destinationIndex: number) => void;
  onSelectNode: (node: EventPageOutlineNode) => void;
  rootIndex?: number;
  rootNodeCount?: number;
  selectedNodeId?: string;
}) {
  const hasChildren = Boolean(node.children?.length);
  const selected = selectedNodeId === node.id;
  const isAncestor = !selected && ancestorNodeIds.has(node.id);
  const rowClassName = selected
    ? 'flex min-w-0 flex-1 items-center gap-2 rounded-md bg-accent px-2 py-1.5 text-left text-sm text-accent-foreground'
    : isAncestor
      ? 'flex min-w-0 flex-1 items-center gap-2 rounded-md bg-accent/45 px-2 py-1.5 text-left text-sm text-foreground'
      : 'flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground';
  return (
    <li>
      <div className="flex min-w-0 items-center gap-1">
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
            <span className="max-w-24 shrink truncate text-[11px] text-muted-foreground">
              {node.detail}
            </span>
          ) : null}
        </button>
        {depth === 0 && onMoveNode && rootIndex !== undefined ? (
          <div className="flex shrink-0 items-center">
            <button
              aria-label={`Move ${node.label} up`}
              className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
              disabled={rootIndex === 0}
              onClick={() => onMoveNode(node, rootIndex - 1)}
              type="button"
            >
              <ArrowUp className="size-3.5" />
            </button>
            <button
              aria-label={`Move ${node.label} down`}
              className="inline-flex size-7 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-30"
              disabled={rootIndex === (rootNodeCount ?? 0) - 1}
              onClick={() => onMoveNode(node, rootIndex + 1)}
              type="button"
            >
              <ArrowDown className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
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

function isRetryableLoadError(error: { status?: number } | undefined) {
  return !error?.status || ![400, 401, 403, 404, 422].includes(error.status);
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

function isSupportedEventPagePuckComponentData(
  value: unknown,
): value is EventPagePuckComponentData {
  return isPuckComponentData(value) && eventPagePuckComponentTypeSet.has(value.type);
}

function coercePuckData(value: unknown, fallback: EventPagePuckData): EventPagePuckData {
  if (!isRecord(value) || !isRecord(value.root) || !Array.isArray(value.content)) return fallback;
  const rootProps = isRecord(value.root.props)
    ? (value.root.props as EventPagePuckData['root']['props'])
    : fallback.root.props;
  const zones = isRecord(value.zones)
    ? Object.fromEntries(
        Object.entries(value.zones).flatMap(([zoneName, zoneContent]) =>
          Array.isArray(zoneContent)
            ? [[zoneName, zoneContent.filter(isSupportedEventPagePuckComponentData)]]
            : [],
        ),
      )
    : undefined;
  return {
    root: { props: rootProps },
    content: value.content.filter(isSupportedEventPagePuckComponentData),
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
  const rootProps = data.root.props;
  const hasRootProp = (key: string) => Object.prototype.hasOwnProperty.call(rootProps, key);
  const summary =
    cleanString(rootProps.marketingSummary) ??
    cleanString(description?.props.body) ??
    cleanString(header?.props.description) ??
    cleanString(event.description) ??
    settings.discovery.summary;
  const seoTitle =
    cleanString(rootProps.title) ??
    cleanString(header?.props.title) ??
    cleanString(description?.props.title) ??
    event.title;
  const seoDescription = cleanString(rootProps.description) ?? summary;
  const tags = hasRootProp('tags')
    ? (typeof rootProps.tags === 'string' ? rootProps.tags : '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean)
    : settings.discovery.tags;
  return {
    ...settings,
    discovery: {
      ...settings.discovery,
      summary,
      category: hasRootProp('category')
        ? cleanString(rootProps.category)
        : settings.discovery.category,
      tags,
      seoTitle,
      seoDescription,
      coverImageUrl:
        cleanString(rootProps.coverImageUrl) ??
        cleanString(header?.props.imageUrl) ??
        cleanString(description?.props.imageUrl) ??
        (hasRootProp('coverImageUrl') ? undefined : settings.discovery.coverImageUrl),
      socialImageUrl:
        cleanString(rootProps.socialImageUrl) ??
        cleanString(header?.props.imageUrl) ??
        cleanString(description?.props.imageUrl) ??
        (hasRootProp('socialImageUrl') ? undefined : settings.discovery.socialImageUrl),
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

    function handleCanvasPointer() {
      clearCanvasOutlineTargets(previewDocument as Document);
    }

    previewDocument.addEventListener('pointerdown', handleCanvasPointer, true);
    previewDocument.addEventListener('click', handleCanvasPointer, true);
    return () => {
      previewDocument.removeEventListener('pointerdown', handleCanvasPointer, true);
      previewDocument.removeEventListener('click', handleCanvasPointer, true);
    };
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
        type: 'setData',
        data: (data) => ({
          ...data,
          content: data.content.map((block) =>
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
const structurePanelDefaultWidth = 288;

const EventPageComponentSearchContext = React.createContext('');
const EventPageComponentInsertContext = React.createContext<{
  canInsert: boolean;
  onInserted?: () => void;
}>({ canInsert: false });

function EventPageInspectorPanel({ onClose }: { onClose?: () => void }) {
  const selectedItem = useEventPagePuck((state) => state.selectedItem);
  const dispatch = useEventPagePuck((state) => state.dispatch);
  const itemSelector = useEventPagePuck((state) => state.appState.ui.itemSelector);
  const selectedType = cleanString(selectedItem?.type);
  const [query, setQuery] = React.useState('');
  const [sectionTitles, setSectionTitles] = React.useState<string[]>([]);
  const [hasMatches, setHasMatches] = React.useState(true);
  const fieldsRootRef = React.useRef<HTMLDivElement>(null);
  const lastSectionSelectorRef = React.useRef(itemSelector);
  const selectedLabel = selectedType ? eventPageComponentLabel(selectedType) : 'Page design';

  React.useEffect(() => {
    setQuery('');
  }, [selectedType]);

  React.useEffect(() => {
    if (selectedType && itemSelector) {
      lastSectionSelectorRef.current = itemSelector;
    }
  }, [itemSelector, selectedType]);

  React.useEffect(() => {
    const currentFieldsRoot = fieldsRootRef.current;
    if (!currentFieldsRoot) return;
    const fieldsRoot: HTMLDivElement = currentFieldsRoot;
    const fieldSelector = "[class*='_PuckFields-field_']";

    function refreshSettingsIndex() {
      const topLevelFields = Array.from(
        fieldsRoot.querySelectorAll<HTMLElement>(fieldSelector),
      ).filter((field) => !field.parentElement?.closest<HTMLElement>(fieldSelector));
      const normalizedQuery = query.trim().toLocaleLowerCase();
      let matchingControls = 0;
      let groupCollapsed = false;
      let groupMatchesQuery = false;

      for (const field of topLevelFields) {
        const section = field.querySelector<HTMLElement>('[data-field-section]');
        if (section) {
          groupCollapsed = section.dataset.sectionExpanded !== 'true';
          groupMatchesQuery = Boolean(
            normalizedQuery &&
            (section.dataset.fieldSection ?? '').toLocaleLowerCase().includes(normalizedQuery),
          );
        }
        const fieldMatches =
          !normalizedQuery ||
          (field.textContent ?? '').toLocaleLowerCase().includes(normalizedQuery);
        const matches = fieldMatches || (!section && groupMatchesQuery);
        const hidden = normalizedQuery ? !matches : !section && groupCollapsed;
        field.toggleAttribute('data-settings-filter-hidden', hidden);
        if (matches && (!section || groupMatchesQuery)) {
          matchingControls += 1;
        }
      }

      const titles = Array.from(
        fieldsRoot.querySelectorAll<HTMLElement>('[data-field-section]'),
      ).reduce<string[]>((items, section, index) => {
        const title = section.dataset.fieldSection?.trim();
        if (!title) return items;
        section.id = `event-page-settings-${title
          .toLocaleLowerCase()
          .replace(/[^a-z0-9]+/g, '-')}-${index}`;
        return items.includes(title) ? items : items.concat(title);
      }, []);

      let activeGroup:
        | {
            controls: string[];
            id: string;
            title: string;
            trigger: HTMLButtonElement;
          }
        | undefined;
      let controlledFieldIndex = 0;

      function connectActiveGroup() {
        if (!activeGroup) return;
        if (activeGroup.controls.length > 0) {
          activeGroup.trigger.setAttribute('aria-controls', activeGroup.controls.join(' '));
        } else {
          activeGroup.trigger.removeAttribute('aria-controls');
        }
      }

      for (const field of topLevelFields) {
        const section = field.querySelector<HTMLElement>('[data-field-section]');
        if (section) {
          connectActiveGroup();
          const trigger = section.querySelector<HTMLButtonElement>('button');
          const title = section.dataset.fieldSection?.trim();
          if (!trigger || !title || !section.id) {
            activeGroup = undefined;
            continue;
          }
          trigger.id = `${section.id}-trigger`;
          activeGroup = {
            controls: [],
            id: section.id,
            title,
            trigger,
          };
          continue;
        }
        field.removeAttribute('aria-labelledby');
        delete field.dataset.settingsGroup;
        if (!activeGroup) continue;
        const controlId = `${activeGroup.id}-control-${controlledFieldIndex++}`;
        field.id = controlId;
        field.dataset.settingsGroup = activeGroup.title;
        field.setAttribute('aria-labelledby', activeGroup.trigger.id);
        activeGroup.controls.push(controlId);
      }
      connectActiveGroup();
      setSectionTitles(titles);
      setHasMatches(!normalizedQuery || matchingControls > 0);
    }

    refreshSettingsIndex();
    const observer = new MutationObserver(refreshSettingsIndex);
    observer.observe(fieldsRoot, {
      attributeFilter: ['data-section-expanded'],
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => observer.disconnect();
  }, [query, selectedType]);

  function scrollToSection(title: string) {
    const sections = Array.from(
      fieldsRootRef.current?.querySelectorAll<HTMLElement>('[data-field-section]') ?? [],
    );
    const section = sections.find((candidate) => candidate.dataset.fieldSection === title);
    const trigger = section?.querySelector<HTMLButtonElement>('button');
    if (trigger?.getAttribute('aria-expanded') === 'false') trigger.click();
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return (
    <div
      className="tk-ep-inspector flex h-full min-h-0 w-full flex-col bg-background"
      data-testid="event-page-inspector"
    >
      <div className="sticky top-0 z-20 border-b bg-background/95 px-4 py-3 backdrop-blur">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {selectedType ? 'Selected section' : 'Whole page'}
            </p>
            <p className="mt-0.5 truncate text-base font-semibold tracking-tight">
              {selectedLabel}
            </p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              {selectedType
                ? 'Edit content on the canvas. Adjust layout and appearance here.'
                : 'Adjust the page theme, discovery, and social preview.'}
            </p>
          </div>
          {onClose ? (
            <button
              aria-label="Close settings"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              onClick={onClose}
              type="button"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        {lastSectionSelectorRef.current ? (
          <fieldset className="mt-3 grid grid-cols-2 rounded-lg bg-muted p-1">
            <legend className="sr-only">Settings scope</legend>
            <button
              aria-pressed={Boolean(selectedType)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                selectedType
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => {
                const selector = lastSectionSelectorRef.current;
                if (selector) {
                  dispatch({
                    type: 'setUi',
                    ui: { itemSelector: selector },
                    recordHistory: false,
                  });
                }
              }}
              type="button"
            >
              This section
            </button>
            <button
              aria-pressed={!selectedType}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                !selectedType
                  ? 'bg-background text-foreground shadow-xs'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
              onClick={() =>
                dispatch({
                  type: 'setUi',
                  ui: { itemSelector: null },
                  recordHistory: false,
                })
              }
              type="button"
            >
              Page styles
            </button>
          </fieldset>
        ) : null}
        <label className="relative mt-3 block">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
          />
          <span className="sr-only">Search settings</span>
          <input
            aria-label="Search settings"
            className="h-9 w-full rounded-md border bg-muted/35 pl-8 pr-8 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:bg-background focus:ring-2 focus:ring-ring/20"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Find a setting…"
            type="search"
            value={query}
          />
          {query ? (
            <button
              aria-label="Clear settings search"
              className="absolute right-1.5 top-1/2 inline-flex size-6 -translate-y-1/2 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
              onClick={() => setQuery('')}
              type="button"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </label>
        {!query && sectionTitles.length > 0 ? (
          <label className="mt-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 border-t pt-2">
            <span className="text-[11px] font-medium text-muted-foreground">Jump to</span>
            <span className="relative min-w-0">
              <select
                aria-label="Jump to setting group"
                className="h-8 w-full appearance-none rounded-md border bg-background py-1 pl-2.5 pr-8 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent/40 focus:border-ring focus:ring-2 focus:ring-ring/20"
                defaultValue=""
                onChange={(event) => {
                  const title = event.currentTarget.value;
                  if (title) scrollToSection(title);
                  event.currentTarget.value = '';
                }}
              >
                <option value="">Choose a settings group…</option>
                {sectionTitles.map((title) => (
                  <option key={title} value={title}>
                    {title}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden="true"
                className="pointer-events-none absolute right-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
              />
            </span>
          </label>
        ) : null}
      </div>
      <div className="tk-ep-inspector__fields min-h-0 flex-1 overflow-y-auto" ref={fieldsRootRef}>
        <Puck.Fields />
        {!hasMatches ? (
          <output className="m-4 block rounded-lg border border-dashed p-5 text-center">
            <p className="text-sm font-medium">No matching settings</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Try a control name such as color, spacing, image, or alignment.
            </p>
            <button
              className="mt-3 rounded-md border px-3 py-1.5 text-xs font-medium hover:bg-accent"
              onClick={() => setQuery('')}
              type="button"
            >
              Clear search
            </button>
          </output>
        ) : null}
      </div>
    </div>
  );
}

function EventPageNavigatorPanel({
  canInsert,
  data,
  onCancelDrag,
  onCancelTargetChange,
  onClose,
  onInsert,
  onNavigate,
  onTabChange,
  tab,
  width,
}: {
  canInsert: boolean;
  data: EventPagePuckData;
  onCancelDrag: (data: EventPagePuckCoreData) => void;
  onCancelTargetChange: (active: boolean) => void;
  onClose?: () => void;
  onInsert?: () => void;
  onNavigate?: () => void;
  onTabChange: (tab: EventPageNavigatorTab) => void;
  tab: EventPageNavigatorTab;
  width?: number;
}) {
  return (
    <aside
      aria-label="Page builder"
      className="tk-ep-inspector flex h-full min-h-0 shrink-0 flex-col bg-background"
      data-testid="event-page-navigator-panel"
      style={width ? { width } : undefined}
    >
      <div className="sticky top-0 z-10 border-b bg-background/95 px-3 py-3 backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <div className="grid min-w-0 flex-1 grid-cols-2 rounded-lg bg-muted p-1">
            {(['sections', 'add'] as const).map((item) => (
              <button
                aria-pressed={tab === item}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  tab === item
                    ? 'bg-background text-foreground shadow-xs'
                    : 'text-foreground/75 hover:text-foreground'
                }`}
                key={item}
                onClick={() => onTabChange(item)}
                type="button"
              >
                {item === 'sections' ? 'Sections' : 'Add'}
              </button>
            ))}
          </div>
          {onClose ? (
            <button
              aria-label="Close page builder"
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              onClick={onClose}
              type="button"
            >
              <X className="size-4" />
            </button>
          ) : null}
        </div>
        <p className="mt-2 px-1 text-[11px] text-muted-foreground">
          {tab === 'sections'
            ? 'Select, inspect, and reorder the page.'
            : 'Search or drag a section onto the canvas.'}
        </p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'sections' ? (
          <div className="space-y-2 p-3" data-testid="event-page-outline">
            <EventPageDocumentOutline data={data} onNavigate={onNavigate} />
          </div>
        ) : (
          <EventPagePuckComponentsButton
            canInsert={canInsert}
            inline
            onCancelDrag={onCancelDrag}
            onCancelTargetChange={onCancelTargetChange}
            onInserted={onInsert}
          />
        )}
      </div>
    </aside>
  );
}

function EventPagePanelToggle({
  icon,
  label,
  onClick,
  open,
}: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  open: boolean;
}) {
  return (
    <button
      aria-label={label}
      aria-pressed={open}
      className={`inline-flex h-8 items-center gap-2 rounded-md border px-2.5 text-xs font-medium transition-colors ${
        open
          ? 'border-foreground/20 bg-accent text-accent-foreground'
          : 'border-border bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground'
      }`}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function EventPageMobileTool({
  active,
  icon,
  label,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      aria-pressed={active}
      className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-lg px-1 py-2 text-[10px] font-medium transition-colors ${
        active ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
      }`}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function EventPageMobilePanelOverlay({
  children,
  label,
  mode,
  onClose,
}: {
  children: React.ReactNode;
  label: string;
  mode: Exclude<EventPageMobilePanel, null>;
  onClose: () => void;
}) {
  const panelRef = React.useRef<HTMLDialogElement>(null);
  useModalFocusTrap(panelRef, onClose);

  React.useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const desktopQuery = window.matchMedia('(min-width: 1024px)');
    const closeOnDesktop = (query: MediaQueryList | MediaQueryListEvent) => {
      if (query.matches) onClose();
    };
    closeOnDesktop(desktopQuery);
    desktopQuery.addEventListener('change', closeOnDesktop);
    return () => desktopQuery.removeEventListener('change', closeOnDesktop);
  }, [onClose]);
  const positionClassName =
    mode === 'add'
      ? 'top-[34%] rounded-t-2xl'
      : mode === 'settings'
        ? 'top-[10%] rounded-t-2xl'
        : 'top-[38%] rounded-t-2xl';

  return (
    <dialog
      aria-label={label}
      aria-modal={mode === 'add' ? 'false' : 'true'}
      className={`absolute inset-x-0 bottom-[72px] z-40 m-0 h-auto w-full max-w-none border-0 border-t bg-background p-0 shadow-2xl lg:hidden ${positionClassName}`}
      open
      ref={panelRef}
      tabIndex={-1}
    >
      {children}
    </dialog>
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

function FocusEventPageTarget({
  onFocused,
  target,
}: {
  onFocused: () => void;
  target: EventPageFocusTarget;
}) {
  const dispatch = useEventPagePuck((state) => state.dispatch);

  React.useEffect(() => {
    if (target === null) return;
    dispatch({
      type: 'setUi',
      ui: { itemSelector: target === 'root' ? null : { index: target } },
    });
    onFocused();
  }, [dispatch, onFocused, target]);

  return null;
}

function EventPagePuckComponentsButton({
  canInsert,
  inline = false,
  onCancelDrag,
  onCancelTargetChange,
  onInserted,
}: {
  canInsert: boolean;
  inline?: boolean;
  onCancelDrag: (data: EventPagePuckCoreData) => void;
  onCancelTargetChange: (active: boolean) => void;
  onInserted?: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [cancelTargetActive, setCancelTargetActive] = React.useState(false);
  const appState = useEventPagePuck((state) => state.appState);
  const isDragging = appState.ui.isDragging;
  const dispatch = useEventPagePuck((state) => state.dispatch);
  const { can } = usePermissions();
  const canInsertUnsafeEmbed = can('settings.write');
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

  const normalizedQuery = React.useMemo(() => query.trim().toLowerCase(), [query]);
  const hasMatchingComponents = React.useMemo(
    () =>
      EVENT_PAGE_PUCK_COMPONENT_TYPES.some(
        (componentType) =>
          (componentType !== 'CustomEmbed' || canInsertUnsafeEmbed) &&
          eventPageComponentLabel(componentType).toLowerCase().includes(normalizedQuery),
      ),
    [canInsertUnsafeEmbed, normalizedQuery],
  );
  const insertContextValue = React.useMemo(
    () => ({ canInsert, onInserted }),
    [canInsert, onInserted],
  );

  const library = (
    <EventPageComponentSearchContext.Provider value={normalizedQuery}>
      <EventPageComponentInsertContext.Provider value={insertContextValue}>
        <Drawer>
          <div
            className={[
              'space-y-3 p-3 text-popover-foreground',
              '[&_[class*="ComponentList-content"]]:pt-2',
              '[&_[class*="ComponentList-title"]]:rounded-md [&_[class*="ComponentList-title"]]:px-2 [&_[class*="ComponentList-title"]]:py-1.5 [&_[class*="ComponentList-title"]]:text-xs [&_[class*="ComponentList-title"]]:font-semibold [&_[class*="ComponentList-title"]]:uppercase [&_[class*="ComponentList-title"]]:tracking-normal [&_[class*="ComponentList-title"]]:text-muted-foreground [&_[class*="ComponentList-title"]]:hover:bg-muted/70',
              '[&_[class*="Drawer"]]:grid [&_[class*="Drawer"]]:grid-cols-1 [&_[class*="Drawer"]]:gap-2',
              '[&_[data-puck-drawer-item]]:w-full',
              '[&_[data-puck-drawer-item]:has([data-event-page-drawer-hidden])]:hidden',
              isDragging && !cancelTargetActive
                ? 'rounded-md ring-2 ring-primary/40 ring-offset-2 ring-offset-background'
                : '',
              cancelTargetActive
                ? 'rounded-md ring-2 ring-destructive/70 ring-offset-2 ring-offset-background'
                : '',
            ].join(' ')}
            data-testid="event-page-puck-components"
          >
            <label className="relative block">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <input
                aria-label="Search page sections"
                className="h-9 w-full rounded-md border bg-background pl-9 pr-3 text-sm outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-2 focus:ring-ring/20"
                data-modal-autofocus
                onChange={(event) => setQuery(event.currentTarget.value)}
                placeholder="Search sections"
                type="search"
                value={query}
              />
            </label>
            {isDragging ? (
              <span
                className={[
                  'inline-flex w-full items-center justify-center gap-1.5 rounded-md border px-2 py-2 text-xs font-medium transition-colors',
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
            ) : null}
            <Puck.Components />
            {!hasMatchingComponents ? (
              <output className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                No sections match “{query.trim()}”.
              </output>
            ) : null}
          </div>
        </Drawer>
      </EventPageComponentInsertContext.Provider>
    </EventPageComponentSearchContext.Provider>
  );

  if (inline) return library;

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
        {library}
      </PopoverContent>
    </Popover>
  );
}

function EventPagePuckDrawerItem({ name }: { children: React.ReactNode; name: string }) {
  const query = React.useContext(EventPageComponentSearchContext);
  const { can } = usePermissions();
  const { canInsert, onInserted } = React.useContext(EventPageComponentInsertContext);
  const appState = useEventPagePuck((state) => state.appState);
  const dispatch = useEventPagePuck((state) => state.dispatch);
  const label = eventPageComponentLabel(name);
  if (name === 'CustomEmbed' && !can('settings.write')) {
    return <div aria-hidden="true" className="hidden" data-event-page-drawer-hidden />;
  }
  if (query && !label.toLowerCase().includes(query)) {
    return <div aria-hidden="true" className="hidden" data-event-page-drawer-hidden />;
  }

  function insertComponent() {
    if (!canInsert || (name === 'CustomEmbed' && !can('settings.write'))) return;
    const destinationIndex = appState.data.content.length;
    const destinationZone = 'root:default-zone';
    dispatch({
      type: 'insert',
      componentType: name,
      destinationIndex,
      destinationZone,
    });
    dispatch({
      type: 'setUi',
      ui: { itemSelector: { index: destinationIndex, zone: destinationZone } },
    });
    onInserted?.();
  }

  return (
    <div className="flex w-full items-center gap-2.5 rounded-md border bg-background px-3 py-2.5 text-sm text-foreground shadow-xs">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
        {eventPageComponentIcon(name)}
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <GripVertical className="size-4 shrink-0 text-muted-foreground" />
      <button
        aria-label={`Add ${label}`}
        className="inline-flex h-7 shrink-0 items-center justify-center rounded-md border px-2 text-xs font-medium transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-40"
        disabled={!canInsert}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          insertComponent();
        }}
        onPointerDown={(event) => event.stopPropagation()}
        type="button"
      >
        Add
      </button>
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
    .reduce<AdminProduct[]>((sorted, product) => {
      const insertionIndex = sorted.findIndex(
        (item) =>
          item.sortOrder > product.sortOrder ||
          (item.sortOrder === product.sortOrder && item.name.localeCompare(product.name) > 0),
      );
      if (insertionIndex === -1) return sorted.concat(product);
      return sorted.slice(0, insertionIndex).concat(product, sorted.slice(insertionIndex));
    }, [])
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
    tickets: ticketItems,
    products: productItems,
    resaleListings: [],
    showGetTicketsCta: [...ticketItems, ...productItems].some((item) => item.status === 'active'),
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

const modalFocusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function useModalFocusTrap<T extends HTMLElement>(
  containerRef: React.RefObject<T | null>,
  onClose: () => void,
) {
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const focusableElements = () =>
      Array.from(container.querySelectorAll<HTMLElement>(modalFocusableSelector)).filter(
        (element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true',
      );
    const animationFrame = window.requestAnimationFrame(() => {
      const initialTarget =
        container.querySelector<HTMLElement>('[data-modal-autofocus]') ??
        focusableElements()[0] ??
        container;
      initialTarget.focus();
    });

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = focusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        container?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      window.cancelAnimationFrame(animationFrame);
      document.removeEventListener('keydown', handleKeyDown, true);
      previouslyFocused?.focus();
    };
  }, [containerRef]);
}

function RenameEventPageDialog({
  currentName,
  error,
  onClose,
  onSave,
  saving,
}: {
  currentName: string;
  error?: string;
  onClose: () => void;
  onSave: (name: string) => void;
  saving: boolean;
}) {
  const [name, setName] = React.useState(currentName);
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  useModalFocusTrap(dialogRef, onClose);
  const normalizedName = name.trim();

  return (
    <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px]">
      <dialog
        aria-labelledby="rename-event-page-title"
        aria-modal="true"
        className="fixed left-1/2 top-1/2 m-0 w-[min(92vw,28rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl border bg-background p-0 text-foreground shadow-2xl"
        open
        ref={dialogRef}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (normalizedName) onSave(normalizedName);
          }}
        >
          <div className="border-b px-4 py-3">
            <h2 className="font-semibold" id="rename-event-page-title">
              Rename event page
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              This name identifies the document in the content studio. It does not change the public
              event title.
            </p>
          </div>
          <div className="space-y-2 p-4">
            <label className="text-sm font-medium" htmlFor="event-page-name">
              Document name
            </label>
            <input
              className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
              data-modal-autofocus
              disabled={saving}
              id="event-page-name"
              maxLength={160}
              onChange={(event) => setName(event.currentTarget.value)}
              value={name}
            />
            {error ? (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            ) : null}
          </div>
          <div className="flex justify-end gap-2 border-t px-4 py-3">
            <button
              className="rounded-md border px-3 py-2 text-sm font-medium hover:bg-accent disabled:opacity-50"
              disabled={saving}
              onClick={onClose}
              type="button"
            >
              Cancel
            </button>
            <button
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:opacity-50"
              disabled={!normalizedName || normalizedName === currentName || saving}
              type="submit"
            >
              {saving ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </form>
      </dialog>
    </div>
  );
}

function EventPageVersionHistoryDialog({
  canRestore,
  currentDocument,
  currentDraftId,
  error,
  onClose,
  onPreview,
  onRestore,
  versions,
}: {
  canRestore: boolean;
  currentDocument: EventPageDocument;
  currentDraftId?: string;
  error?: string;
  onClose: () => void;
  onPreview: (version: AdminContentDocumentVersion) => void;
  onRestore: (version: AdminContentDocumentVersion) => void;
  versions: AdminContentDocumentVersion[];
}) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  useModalFocusTrap(dialogRef, onClose);
  const orderedVersions = React.useMemo(
    () =>
      versions.reduce<AdminContentDocumentVersion[]>((ordered, version) => {
        const index = ordered.findIndex((item) => item.versionNumber < version.versionNumber);
        if (index === -1) return ordered.concat(version);
        return ordered.slice(0, index).concat(version, ordered.slice(index));
      }, []),
    [versions],
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px]">
      <dialog
        aria-labelledby="event-page-history-title"
        aria-modal="true"
        className="fixed inset-y-0 right-0 m-0 flex h-full w-full max-w-lg flex-col border-0 border-l bg-background p-0 text-foreground shadow-2xl"
        open
        ref={dialogRef}
      >
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="font-semibold" id="event-page-history-title">
              Version history
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Preview, compare, or restore a saved version as a new draft.
            </p>
          </div>
          <button
            aria-label="Close version history"
            className="inline-flex size-8 items-center justify-center rounded-md border hover:bg-accent"
            data-modal-autofocus
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
        {error ? (
          <p
            className="m-4 mb-0 rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            {error}
          </p>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {orderedVersions.length ? (
            <ol className="space-y-2">
              {orderedVersions.map((version) => (
                <li className="rounded-lg border bg-card p-3 text-card-foreground" key={version.id}>
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        Version {version.versionNumber}
                        <span className="rounded border px-1.5 py-0.5 text-[10px] uppercase text-muted-foreground">
                          {version.status}
                        </span>
                        {version.id === currentDraftId ? (
                          <span className="text-xs text-emerald-700">Current draft</span>
                        ) : null}
                      </p>
                      <p className="mt-1 truncate text-xs text-muted-foreground">
                        {version.subject || 'Untitled event page'}
                      </p>
                      <time
                        className="mt-1 block text-xs text-muted-foreground"
                        dateTime={version.createdAt}
                      >
                        {new Intl.DateTimeFormat(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }).format(new Date(version.createdAt))}
                      </time>
                    </div>
                    <div className="flex shrink-0 flex-col gap-1.5">
                      <button
                        className="rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent"
                        onClick={() => onPreview(version)}
                        type="button"
                      >
                        Preview
                      </button>
                      <button
                        className="rounded-md border px-2.5 py-1.5 text-xs font-medium hover:bg-accent disabled:opacity-40"
                        disabled={!canRestore || version.id === currentDraftId}
                        onClick={() => onRestore(version)}
                        type="button"
                      >
                        Restore
                      </button>
                    </div>
                  </div>
                  <details className="mt-3 border-t pt-2">
                    <summary className="cursor-pointer text-xs font-medium text-muted-foreground hover:text-foreground">
                      Compare with current draft
                    </summary>
                    <div className="mt-2 grid gap-2 xl:grid-cols-2">
                      <div className="min-w-0">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Version {version.versionNumber}
                        </p>
                        <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-2 text-[10px] leading-4">
                          {JSON.stringify(version.contentJson, null, 2)}
                        </pre>
                      </div>
                      <div className="min-w-0">
                        <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                          Current draft
                        </p>
                        <pre className="max-h-72 overflow-auto rounded-md border bg-muted/30 p-2 text-[10px] leading-4">
                          {JSON.stringify(currentDocument, null, 2)}
                        </pre>
                      </div>
                    </div>
                  </details>
                </li>
              ))}
            </ol>
          ) : (
            <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
              No saved versions yet.
            </p>
          )}
        </div>
      </dialog>
    </div>
  );
}

function EventPageDataDialog({
  event,
  onClose,
  productCount,
  ticketCount,
}: {
  event: AdminEventDetail;
  onClose: () => void;
  productCount: number;
  ticketCount: number;
}) {
  const dialogRef = React.useRef<HTMLDialogElement>(null);
  useModalFocusTrap(dialogRef, onClose);
  const rows = [
    ['Event title', event.title],
    ['Description', event.description || 'No description'],
    ['Starts', event.startsAt || 'Not scheduled'],
    ['Timezone', event.timezone || 'Not configured'],
    ['Venue', event.venue?.name || event.venueName || 'Not configured'],
    ['Tickets', `${ticketCount} active ticket type${ticketCount === 1 ? '' : 's'}`],
    ['Products', `${productCount} active product${productCount === 1 ? '' : 's'}`],
  ] as const;

  return (
    <div className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px]">
      <dialog
        aria-labelledby="event-page-data-title"
        aria-modal="true"
        className="fixed left-1/2 top-1/2 m-0 flex max-h-[85svh] w-[min(92vw,36rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-xl border bg-background p-0 text-foreground shadow-2xl"
        open
        ref={dialogRef}
      >
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div>
            <h2 className="font-semibold" id="event-page-data-title">
              Variables &amp; event data
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Event, ticket, and product sections use this managed data automatically. Text you edit
              directly on the canvas remains page content.
            </p>
          </div>
          <button
            aria-label="Close variables and event data"
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border hover:bg-accent"
            data-modal-autofocus
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
        <dl className="min-h-0 flex-1 divide-y overflow-y-auto px-4">
          {rows.map(([label, value]) => (
            <div className="grid gap-1 py-3 sm:grid-cols-[9rem_1fr]" key={label}>
              <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
              <dd className="text-sm break-words">{value}</dd>
            </div>
          ))}
        </dl>
        <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Update managed values from the event workspace.
          </p>
          <a
            className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
            href={`/events/${event.id}`}
          >
            Open event
          </a>
        </div>
      </dialog>
    </div>
  );
}

function PublishReviewDrawer({
  brand,
  draft,
  error,
  onClose,
  onEditIssue,
  onPublish,
  preview,
  publicUrl,
  publishing,
  runtime,
  status,
}: {
  brand?: AdminBrand;
  draft: AdminContentDocumentVersion;
  error?: string;
  onClose: () => void;
  onEditIssue: (field?: string) => void;
  onPublish: (snapshot: EventPageDocument) => void;
  preview: EventPagePreview;
  publicUrl: string;
  publishing: boolean;
  runtime: EventPageRuntime;
  status: string;
}) {
  const [tab, setTab] = React.useState<'rendered' | 'issues' | 'json'>(
    preview.validation.valid ? 'rendered' : 'issues',
  );
  const [viewport, setViewport] = React.useState<EventPagePreviewViewport>('desktop');
  const drawerRef = React.useRef<HTMLDialogElement>(null);
  useModalFocusTrap(drawerRef, onClose);
  const viewportWidth = viewport === 'mobile' ? 390 : viewport === 'tablet' ? 768 : undefined;
  const prospectiveVersion = draft.versionNumber + 1;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/35 backdrop-blur-[1px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !publishing) onClose();
      }}
      role="presentation"
    >
      <dialog
        aria-describedby="publish-review-description"
        aria-labelledby="publish-review-title"
        aria-modal="true"
        className="absolute inset-y-0 right-0 m-0 flex h-full w-full max-w-2xl flex-col border-0 border-l bg-background p-0 text-foreground shadow-2xl"
        data-testid="publish-review-drawer"
        open
        ref={drawerRef}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold" id="publish-review-title">
              Review and publish
            </p>
            <p className="text-xs text-muted-foreground" id="publish-review-description">
              {preview.validation.valid
                ? `Your reviewed snapshot will become draft v${prospectiveVersion}.`
                : `${preview.validation.issues.length} publish blocker${
                    preview.validation.issues.length === 1 ? '' : 's'
                  } must be resolved.`}
            </p>
          </div>
          <button
            aria-label="Close publish review"
            className="inline-flex size-8 items-center justify-center rounded-md border text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            data-modal-autofocus
            disabled={publishing}
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="grid grid-cols-3 gap-2 border-b bg-muted/25 px-4 py-3 text-xs">
          <div>
            <p className="text-muted-foreground">Current status</p>
            <p className="mt-0.5 font-medium capitalize">{status}</p>
          </div>
          <div>
            <p className="text-muted-foreground">Publishing</p>
            <p className="mt-0.5 font-medium">New draft v{prospectiveVersion}</p>
          </div>
          <div className="min-w-0">
            <p className="text-muted-foreground">Destination</p>
            <p className="mt-0.5 truncate font-medium">{publicUrl}</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <div className="flex gap-1">
            {(['rendered', 'issues', 'json'] as const).map((item) => (
              <button
                aria-pressed={tab === item}
                className={`rounded-md px-3 py-1.5 text-xs transition-colors ${
                  tab === item
                    ? 'bg-foreground text-background'
                    : 'text-muted-foreground hover:bg-accent'
                }`}
                key={item}
                onClick={() => setTab(item)}
                type="button"
              >
                {item === 'rendered'
                  ? 'Preview'
                  : item === 'issues'
                    ? `Issues (${preview.validation.issues.length})`
                    : 'JSON'}
              </button>
            ))}
          </div>
          {tab === 'rendered' ? (
            <div aria-label="Preview size" className="flex rounded-md border p-0.5">
              {(['desktop', 'tablet', 'mobile'] as const).map((item) => (
                <button
                  aria-label={`${item} preview`}
                  aria-pressed={viewport === item}
                  className={`rounded px-2 py-1 text-xs capitalize ${
                    viewport === item ? 'bg-accent text-accent-foreground' : 'text-muted-foreground'
                  }`}
                  key={item}
                  onClick={() => setViewport(item)}
                  type="button"
                >
                  {item}
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <div className="min-h-0 flex-1 overflow-auto bg-muted/30">
          {tab === 'rendered' && (
            <div
              className="mx-auto min-h-full bg-background text-foreground shadow-sm transition-[width] duration-250"
              data-testid="preview-public-page-surface"
              style={{
                ...brandThemeStyleFromAdminBrand(brand),
                ...(viewportWidth ? { width: viewportWidth, maxWidth: '100%' } : {}),
              }}
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
                <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-4 text-emerald-700">
                  <p className="flex items-center gap-2 font-medium">
                    <CheckCircle2 className="size-4" /> Ready to publish
                  </p>
                  <p className="mt-1 text-xs">No event-page validation blockers were found.</p>
                </div>
              ) : (
                preview.validation.issues.map((issue, index) => (
                  <div
                    className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-destructive"
                    key={`${issue.code}:${issue.field ?? ''}`}
                  >
                    <p className="font-medium">
                      {index + 1}. {issue.message}
                    </p>
                    {issue.field ? <p className="mt-1 text-xs opacity-75">{issue.field}</p> : null}
                    <button
                      className="mt-2 rounded-md border border-current/25 px-2 py-1 text-xs font-medium transition-colors hover:bg-destructive/10"
                      onClick={() => onEditIssue(issue.field)}
                      type="button"
                    >
                      Edit issue
                    </button>
                  </div>
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
        {error ? (
          <div
            className="mx-4 mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            <XCircle className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-medium">Publishing did not complete</p>
              <p className="mt-0.5 text-xs">{error}</p>
              <p className="mt-1 text-xs opacity-80">
                Your reviewed draft is still here. Resolve the issue and try again.
              </p>
            </div>
          </div>
        ) : null}
        <div className="flex items-center justify-between gap-3 border-t bg-background px-4 py-3">
          <p className="text-xs text-muted-foreground">
            Publishing always saves the current draft first.
          </p>
          <div className="flex items-center gap-2">
            <button
              className="rounded-md border px-3 py-2 text-sm font-medium transition-colors hover:bg-accent"
              disabled={publishing}
              onClick={onClose}
              type="button"
            >
              Keep editing
            </button>
            <button
              className="rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground disabled:pointer-events-none disabled:opacity-50"
              disabled={!preview.validation.valid || publishing}
              onClick={() => onPublish(preview.document)}
              type="button"
            >
              {publishing ? 'Publishing…' : 'Publish now'}
            </button>
          </div>
        </div>
      </dialog>
    </div>
  );
}

export function EventPagePersistedEditorView({
  eventId,
  previewOnly = false,
  onPreviewReady,
  onPreviewError,
}: {
  eventId: string;
  previewOnly?: boolean;
  onPreviewReady?: () => void;
  onPreviewError?: (message: string) => void;
}) {
  const [event, setEvent] = React.useState<AdminEventDetail>();
  const [document, setDocument] = React.useState<AdminContentDocument>();
  const [draft, setDraft] = React.useState<AdminContentDocumentVersion>();
  const [versions, setVersions] = React.useState<AdminContentDocumentVersion[]>([]);
  const [eventPageDocument, setEventPageDocument] = React.useState<EventPageDocument>();
  const [editorChrome, setEditorChrome] = React.useState<EventPageEditorChrome>({
    tickets: [],
    products: [],
  });
  const [structurePanelOpen, setStructurePanelOpen] = React.useState(true);
  const [structurePanelWidth, setStructurePanelWidth] = React.useState(structurePanelDefaultWidth);
  const [navigatorTab, setNavigatorTab] = React.useState<EventPageNavigatorTab>('sections');
  const [inspectorOpen, setInspectorOpen] = React.useState(true);
  const [mobilePanel, setMobilePanel] = React.useState<EventPageMobilePanel>(null);
  const [editorMode, setEditorMode] = React.useState<EditorMode>('editor');
  const [previewViewport, setPreviewViewport] = React.useState<EventPagePreviewViewport>('desktop');
  const [cancelDropTargetActive, setCancelDropTargetActive] = React.useState(false);
  const [preview, setPreview] = React.useState<EventPagePreview>();
  const [publishReviewOpen, setPublishReviewOpen] = React.useState(false);
  const [renameOpen, setRenameOpen] = React.useState(false);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [dataDialogOpen, setDataDialogOpen] = React.useState(false);
  const [isRenaming, setIsRenaming] = React.useState(false);
  const [isPublishing, setIsPublishing] = React.useState(false);
  const [puckSessionRevision, setPuckSessionRevision] = React.useState(0);
  const [focusTarget, setFocusTarget] = React.useState<EventPageFocusTarget>(null);
  const [autosave, setAutosave] = React.useState<AutosaveState>('idle');
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string>();
  const [loadRetryable, setLoadRetryable] = React.useState(true);
  const [actionError, setActionError] = React.useState<string>();
  const [notice, setNotice] = React.useState<string>();
  const operationIdRef = React.useRef(0);
  const publishRetryRef = React.useRef<
    | {
        snapshotKey: string;
        version: AdminContentDocumentVersion;
      }
    | undefined
  >(undefined);
  const { can } = usePermissions();
  const isArchived = document?.status === 'archived';
  const canWrite = can('events.write');
  const canManageUnsafeEmbeds = can('settings.write');
  const canEdit = !isArchived && canWrite;
  const pageRuntime = React.useMemo(() => buildPageRuntime(editorChrome), [editorChrome]);
  const hasCommerceItems = pageRuntime.tickets.length > 0;
  const overrides = React.useMemo(
    () => puckOverrides(pageRuntime, editorChrome.brand),
    [editorChrome.brand, pageRuntime],
  );
  const uploadEventPageImage = React.useCallback<EventPagePuckUploadImage>(
    async (file) => {
      if (!canEdit) {
        throw new Error('You do not have permission to upload event page images.');
      }
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
    [canEdit, document?.id, event?.brandId, event?.id],
  );
  const puckConfig = React.useMemo(
    () =>
      createEventPagePuckConfig({
        allowUnsafeEmbeds: canManageUnsafeEmbeds,
        hasCommerceItems,
        hasProductItems: (pageRuntime.products?.length ?? 0) > 0,
        onUploadImage: uploadEventPageImage,
      }),
    [canManageUnsafeEmbeds, hasCommerceItems, pageRuntime.products?.length, uploadEventPageImage],
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
    setLoadRetryable(true);
    setError(undefined);
    setActionError(undefined);
    setNotice(undefined);

    const eventResult = await adminApi.getEvent(eventId);
    if (!eventResult.ok) {
      setLoadRetryable(isRetryableLoadError(eventResult.error));
      setError(resultMessage(eventResult.error, 'Unable to load event'));
      setLoading(false);
      return;
    }
    const loadedEvent = eventResult.data;
    if (!loadedEvent.organizationId || !loadedEvent.brandId) {
      setLoadRetryable(false);
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
      setLoadRetryable(isRetryableLoadError(documentsResult.error));
      setError(resultMessage(documentsResult.error, 'Unable to load event page content documents'));
      setLoading(false);
      return;
    }

    const documents = listItemsFromResponse<AdminContentDocument>(documentsResult.data);
    let loadedDocument = documents.find(
      (item) => item.channel === 'event_page' && item.eventId === loadedEvent.id,
    );
    if (!loadedDocument) {
      if (!canWrite) {
        setLoadRetryable(false);
        setError('No event page exists yet, and you do not have permission to create one.');
        setLoading(false);
        return;
      }
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
        setLoadRetryable(isRetryableLoadError(createResult.error));
        setError(resultMessage(createResult.error, 'Unable to create event page content document'));
        setLoading(false);
        return;
      }
      loadedDocument = createResult.data;
    }

    const versionsResult = await adminApi.listContentVersions(loadedDocument.id);
    if (!versionsResult.ok) {
      setLoadRetryable(isRetryableLoadError(versionsResult.error));
      setError(resultMessage(versionsResult.error, 'Unable to load event page versions'));
      setLoading(false);
      return;
    }

    let loadedVersions = listItemsFromResponse<AdminContentDocumentVersion>(versionsResult.data);
    let loadedDraft = latestDraft(loadedVersions, loadedDocument);
    if (!loadedDraft) {
      if (!canWrite) {
        setLoadRetryable(false);
        setError('This event page has no draft, and you do not have permission to create one.');
        setLoading(false);
        return;
      }
      const initialDocument = createDefaultDocument(loadedEvent);
      const saveResult = await adminApi.saveContentVersion(
        loadedDocument.id,
        saveBodyForDocument(initialDocument, loadedEvent),
      );
      if (!saveResult.ok) {
        setLoadRetryable(isRetryableLoadError(saveResult.error));
        setError(resultMessage(saveResult.error, 'Unable to create the initial event page draft'));
        setLoading(false);
        return;
      }
      loadedDraft = saveResult.data;
      loadedVersions = [saveResult.data];
    }

    const normalized = coerceStoredEventPageDocument(loadedDraft.contentJson, loadedEvent);
    if (!normalized) {
      setLoadRetryable(false);
      setError('Saved event page draft is not a schemaVersion 2 Puck document.');
      setLoading(false);
      return;
    }

    const [brandsResult, ticketsResult, productsResult] = await Promise.all([
      adminApi.listBrands(),
      adminApi.listTicketTypes(loadedEvent.id),
      adminApi.listProducts(loadedEvent.id),
    ]);
    const supportingDataFailure = !brandsResult.ok
      ? {
          error: brandsResult.error,
          message: 'Unable to load event page branding',
        }
      : !ticketsResult.ok
        ? {
            error: ticketsResult.error,
            message: 'Unable to load event page ticket types',
          }
        : !productsResult.ok
          ? {
              error: productsResult.error,
              message: 'Unable to load event page products',
            }
          : undefined;
    if (supportingDataFailure) {
      setLoadRetryable(isRetryableLoadError(supportingDataFailure.error));
      setError(resultMessage(supportingDataFailure.error, supportingDataFailure.message));
      setLoading(false);
      return;
    }
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
    setVersions(loadedVersions);
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
  }, [canWrite, eventId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (!previewOnly) return;
    if (error) onPreviewError?.(error);
    else if (!loading && eventPageDocument && preview) onPreviewReady?.();
  }, [error, eventPageDocument, loading, onPreviewError, onPreviewReady, preview, previewOnly]);

  async function saveDraft(operationId = nextOperationId(), snapshot = eventPageDocument) {
    if (!document || !event || !snapshot || !canEdit) return undefined;
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
    setVersions((current) => [
      result.data,
      ...current.filter((version) => version.id !== result.data.id),
    ]);
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

  const autosaveDraftRef = React.useRef(saveDraft);
  autosaveDraftRef.current = saveDraft;

  React.useEffect(() => {
    if (autosave !== 'idle' || !canEdit || !eventPageDocument || isPublishing) {
      return;
    }
    const timer = window.setTimeout(() => {
      void autosaveDraftRef.current();
    }, 1200);
    return () => window.clearTimeout(timer);
  }, [autosave, canEdit, eventPageDocument, isPublishing]);

  React.useEffect(() => {
    if (autosave === 'saved') return;
    const warnBeforeUnload = (unloadEvent: BeforeUnloadEvent) => {
      unloadEvent.preventDefault();
      unloadEvent.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [autosave]);

  async function saveBeforeBackNavigation(clickEvent: React.MouseEvent<HTMLAnchorElement>) {
    if (autosave === 'saving') {
      clickEvent.preventDefault();
      setNotice('Finishing your save—try Back again in a moment.');
      return;
    }
    if (autosave !== 'idle' && autosave !== 'error') return;
    clickEvent.preventDefault();
    const destination = clickEvent.currentTarget.href;
    const saved = await saveDraft();
    if (saved) window.location.assign(destination);
  }

  function openPreview() {
    if (!eventPageDocument || isArchived) return;
    setPreview({
      label:
        autosave === 'saved' ? `Saved draft v${draft?.versionNumber ?? ''}` : 'Unsaved preview',
      document: eventPageDocument,
      validation: validateEventPageDocument(eventPageDocument),
    });
    setEditorMode('preview');
    setMobilePanel(null);
    setActionError(undefined);
  }

  function requestPublishReview(snapshot = eventPageDocument) {
    if (!snapshot || !canEdit) return;
    setPreview({
      label: autosave === 'saved' ? `Saved draft v${draft?.versionNumber ?? ''}` : 'Unsaved draft',
      document: snapshot,
      validation: validateEventPageDocument(snapshot),
    });
    setPublishReviewOpen(true);
    setActionError(undefined);
  }

  function editValidationIssue(field?: string) {
    const contentIndexMatch = field?.match(/^editor\.data\.content\.(\d+)/);
    setFocusTarget(contentIndexMatch ? Number(contentIndexMatch[1]) : 'root');
    setPublishReviewOpen(false);
    setEditorMode('editor');
    setNavigatorTab('sections');
    setStructurePanelOpen(true);
    setInspectorOpen(true);
    setMobilePanel(
      typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(max-width: 1023px)').matches
        ? 'settings'
        : null,
    );
  }

  async function publishDraft(snapshot = eventPageDocument) {
    if (!document || !snapshot || !canEdit || isPublishing) return;
    const operationId = nextOperationId();
    setIsPublishing(true);
    try {
      const snapshotKey = JSON.stringify(snapshot);
      const retryCandidate = publishRetryRef.current;
      const saved =
        retryCandidate?.snapshotKey === snapshotKey
          ? { version: retryCandidate.version, document: snapshot }
          : await saveDraft(operationId, snapshot);
      if (!saved) return;
      publishRetryRef.current = {
        snapshotKey,
        version: saved.version,
      };
      const result = await adminApi.publishContentVersion(document.id, saved.version.id);
      if (!isCurrentOperation(operationId)) return;
      if (!result.ok) {
        setActionError(resultMessage(result.error, 'Unable to publish event page'));
        return;
      }
      setDocument(result.data.document);
      publishRetryRef.current = undefined;
      setDraft(result.data.version);
      setVersions((current) => [
        result.data.version,
        ...current.filter((version) => version.id !== result.data.version.id),
      ]);
      setPublishReviewOpen(false);
      setActionError(undefined);
      setNotice(`Published v${result.data.version.versionNumber}`);
      toast.success('Event page published');
    } finally {
      setIsPublishing(false);
    }
  }

  async function archiveDocument() {
    if (!document || !canEdit) return;
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
      setActionError(resultMessage(result.error, 'Unable to archive event page'));
      return;
    }
    setDocument(result.data);
    setActionError(undefined);
    setNotice('Archived event page');
    toast.success('Event page archived');
  }

  async function renameDocument(name: string) {
    if (!document || !canEdit || isRenaming) return;
    setIsRenaming(true);
    setActionError(undefined);
    try {
      const result = await adminApi.updateContentDocument(document.id, {
        name,
      });
      if (!result.ok) {
        setActionError(resultMessage(result.error, 'Unable to rename event page'));
        return;
      }
      setDocument(result.data);
      setRenameOpen(false);
      setNotice(`Renamed event page to ${result.data.name}`);
      toast.success('Event page renamed');
    } finally {
      setIsRenaming(false);
    }
  }

  function previewVersion(version: AdminContentDocumentVersion) {
    if (!event) return;
    const versionDocument = coerceStoredEventPageDocument(version.contentJson, event);
    if (!versionDocument) {
      setActionError(`Version ${version.versionNumber} is not a valid event page.`);
      return;
    }
    setPreview({
      label: `Saved version ${version.versionNumber}`,
      document: versionDocument,
      validation: validateEventPageDocument(versionDocument),
    });
    setHistoryOpen(false);
    setEditorMode('preview');
    setPreviewViewport('desktop');
    setNotice(`Previewing saved version ${version.versionNumber}`);
  }

  function restoreVersion(version: AdminContentDocumentVersion) {
    if (!event || !canEdit) return;
    const versionDocument = coerceStoredEventPageDocument(version.contentJson, event);
    if (!versionDocument) {
      setActionError(`Version ${version.versionNumber} is not a valid event page.`);
      return;
    }
    publishRetryRef.current = undefined;
    setEventPageDocument(versionDocument);
    setPuckSessionRevision((revision) => revision + 1);
    setPreview({
      label: `Restored from version ${version.versionNumber}`,
      document: versionDocument,
      validation: validateEventPageDocument(versionDocument),
    });
    setHistoryOpen(false);
    setEditorMode('editor');
    markDraftDirty();
    setNotice(`Restored version ${version.versionNumber} as a new draft`);
  }

  async function duplicateDocument() {
    if (!document || !eventPageDocument || !canEdit) return;
    const operationId = nextOperationId();
    const saved = await saveDraft(operationId, eventPageDocument);
    if (!saved) return;
    const result = await adminApi.duplicateContentDocument(document.id, {
      name: duplicateDocumentName(document.name),
    });
    if (!isCurrentOperation(operationId)) return;
    if (!result.ok) {
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
      publishRetryRef.current = undefined;
      markDraftDirty();
    }
  }

  function cancelPuckDrag(data: EventPagePuckCoreData) {
    setCurrentPuckData(data, { markDirty: false });
  }

  function startStructurePanelResize(pointerEvent: React.PointerEvent<HTMLElement>) {
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

  function resizeStructurePanelWithKeyboard(keyboardEvent: React.KeyboardEvent<HTMLElement>) {
    const delta = keyboardEvent.shiftKey ? 40 : 12;
    if (keyboardEvent.key !== 'ArrowLeft' && keyboardEvent.key !== 'ArrowRight') return;
    keyboardEvent.preventDefault();
    setStructurePanelWidth((width) =>
      Math.min(
        structurePanelMaxWidth,
        Math.max(
          structurePanelMinWidth,
          width + (keyboardEvent.key === 'ArrowRight' ? delta : -delta),
        ),
      ),
    );
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
          <div className="flex flex-wrap gap-2">
            <a
              className="rounded-md border px-3 py-2 text-sm transition-colors hover:bg-accent"
              href={`/events/${eventId}`}
            >
              Back to event
            </a>
            {loadRetryable ? (
              <button
                className="rounded-md bg-primary px-3 py-2 text-sm text-primary-foreground transition-colors"
                onClick={() => void load()}
                type="button"
              >
                Retry
              </button>
            ) : null}
          </div>
        </div>
      </section>
    );
  }

  const archivedReason = isArchived ? 'Archived pages are read-only.' : undefined;
  const localValidation = validateEventPageDocument(eventPageDocument);
  if (previewOnly) {
    return (
      <div
        className="min-h-[32rem] overflow-hidden rounded-lg bg-background text-foreground"
        data-testid="authenticated-event-page-preview"
        style={brandThemeStyleFromAdminBrand(editorChrome.brand)}
      >
        <EventPageRender
          brandVariables={brandVariablesFromAdminBrand(editorChrome.brand)}
          document={eventPageDocument}
          runtime={pageRuntime}
          validate={false}
        />
      </div>
    );
  }
  const publishDisabled = !canEdit || autosave === 'saving' || isPublishing;
  const autosaveLabel =
    autosave === 'idle'
      ? 'Unsaved changes'
      : autosave === 'saving'
        ? 'Saving…'
        : autosave === 'saved'
          ? 'Saved'
          : 'Save failed';
  const permissions: Partial<Permissions> = {
    delete: canEdit,
    drag: canEdit,
    duplicate: canEdit,
    edit: canEdit,
    insert: canEdit,
  };
  const moreActionsItems: DropdownMenuItemConfig[] = [
    {
      id: 'rename',
      label: 'Rename page',
      icon: <Pencil className="size-4" />,
      onClick: () => {
        setActionError(undefined);
        setRenameOpen(true);
      },
      disabled: !canEdit,
    },
    {
      id: 'history',
      label: 'Version history',
      icon: <ListChecks className="size-4" />,
      onClick: () => {
        setActionError(undefined);
        setHistoryOpen(true);
      },
    },
    {
      id: 'variables',
      label: 'Variables & event data',
      icon: <Type className="size-4" />,
      onClick: () => setDataDialogOpen(true),
      separatorAfter: true,
    },
    {
      id: 'edit',
      label: 'Edit page',
      icon: <Pencil className="size-4" />,
      onClick: () => {
        setEditorMode('editor');
        setMobilePanel(null);
      },
      disabled: editorMode === 'editor',
    },
    {
      id: 'preview',
      label: 'Preview current draft',
      icon: <Eye className="size-4" />,
      onClick: openPreview,
      disabled: Boolean(archivedReason),
    },
    {
      id: 'code',
      label: 'View page JSON',
      icon: <Code2 className="size-4" />,
      onClick: () => {
        setEditorMode('code');
        setMobilePanel(null);
      },
      separatorAfter: true,
    },
    {
      id: 'save',
      label: 'Save draft',
      icon: <Save className="size-4" />,
      onClick: () => void saveDraft(),
      disabled: !canEdit || autosave === 'saving',
      separatorAfter: true,
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
      disabled: !canEdit,
      separatorAfter: true,
    },
    {
      id: 'archive',
      label: 'Archive page',
      icon: <Archive className="size-4" />,
      onClick: () => void archiveDocument(),
      disabled: !canEdit,
      destructive: true,
    },
  ];

  const editorCanvas = (
    <main
      aria-label="Event page editable document"
      className="relative min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/30"
      data-testid="editor-canvas"
    >
      <div className="flex h-full min-h-0 overflow-hidden">
        {structurePanelOpen && (
          <>
            <div className="hidden h-full shrink-0 border-r lg:block">
              <EventPageNavigatorPanel
                canInsert={canEdit}
                data={eventPageDocument.editor.data}
                onCancelDrag={cancelPuckDrag}
                onCancelTargetChange={setCancelDropTargetActive}
                onClose={() => setStructurePanelOpen(false)}
                onTabChange={setNavigatorTab}
                tab={navigatorTab}
                width={structurePanelWidth}
              />
            </div>
            <input
              aria-label="Resize page builder"
              aria-orientation="horizontal"
              max={structurePanelMaxWidth}
              min={structurePanelMinWidth}
              className="group hidden h-full w-1.5 shrink-0 cursor-col-resize items-center justify-center border-r bg-background text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground lg:flex"
              onChange={(inputEvent) =>
                setStructurePanelWidth(Number(inputEvent.currentTarget.value))
              }
              onKeyDown={resizeStructurePanelWithKeyboard}
              onPointerDown={startStructurePanelResize}
              type="range"
              value={structurePanelWidth}
            />
          </>
        )}
        <div
          className="min-h-0 min-w-0 flex-1 overflow-hidden pb-[72px] lg:pb-0"
          inert={Boolean(mobilePanel && mobilePanel !== 'add')}
        >
          <Puck.Preview />
        </div>
        {inspectorOpen ? (
          <div className="hidden h-full w-80 shrink-0 border-l xl:w-[22rem] lg:block">
            <EventPageInspectorPanel onClose={() => setInspectorOpen(false)} />
          </div>
        ) : null}
      </div>

      {mobilePanel ? (
        <EventPageMobilePanelOverlay
          label={`${mobilePanel === 'settings' ? 'Settings' : mobilePanel === 'add' ? 'Add sections' : 'Sections'} panel`}
          mode={mobilePanel}
          onClose={() => setMobilePanel(null)}
        >
          {mobilePanel === 'settings' ? (
            <EventPageInspectorPanel onClose={() => setMobilePanel(null)} />
          ) : (
            <EventPageNavigatorPanel
              canInsert={canEdit}
              data={eventPageDocument.editor.data}
              onCancelDrag={cancelPuckDrag}
              onCancelTargetChange={setCancelDropTargetActive}
              onClose={() => setMobilePanel(null)}
              onInsert={() => setMobilePanel(null)}
              onNavigate={() => setMobilePanel(null)}
              onTabChange={(tab) => setMobilePanel(tab)}
              tab={mobilePanel}
            />
          )}
        </EventPageMobilePanelOverlay>
      ) : null}

      <nav
        aria-label="Event page tools"
        className="absolute inset-x-3 bottom-2 z-50 flex h-14 items-stretch gap-1 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur lg:hidden"
      >
        <EventPageMobileTool
          active={!mobilePanel && editorMode === 'editor'}
          icon={<Pencil className="size-4" />}
          label="Edit"
          onClick={() => setMobilePanel(null)}
        />
        <EventPageMobileTool
          active={mobilePanel === 'sections'}
          icon={<PanelLeftOpen className="size-4" />}
          label="Sections"
          onClick={() => setMobilePanel((panel) => (panel === 'sections' ? null : 'sections'))}
        />
        <EventPageMobileTool
          active={mobilePanel === 'add'}
          icon={<Plus className="size-4" />}
          label="Add"
          onClick={() => setMobilePanel((panel) => (panel === 'add' ? null : 'add'))}
        />
        <EventPageMobileTool
          active={mobilePanel === 'settings'}
          icon={<Settings2 className="size-4" />}
          label="Settings"
          onClick={() => setMobilePanel((panel) => (panel === 'settings' ? null : 'settings'))}
        />
        <EventPageMobileTool
          active={false}
          icon={<Eye className="size-4" />}
          label="Preview"
          onClick={openPreview}
        />
      </nav>
    </main>
  );

  const previewWidth =
    previewViewport === 'mobile' ? 390 : previewViewport === 'tablet' ? 768 : undefined;
  const previewCanvas = (
    <main
      aria-label="Event page preview"
      className="min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/30"
      data-testid="editor-canvas"
    >
      <div className="h-full overflow-auto px-0 py-0 sm:px-4 sm:py-4">
        <div
          className="relative mx-auto min-h-full bg-background text-foreground shadow-sm transition-[width] duration-250"
          data-testid="preview-mode-public-page-surface"
          style={{
            ...brandThemeStyleFromAdminBrand(editorChrome.brand),
            ...(previewWidth ? { width: previewWidth, maxWidth: '100%' } : {}),
          }}
        >
          <EventPageRender
            brandVariables={brandVariablesFromAdminBrand(editorChrome.brand)}
            document={preview.document}
            runtime={pageRuntime}
            validate={false}
          />
        </div>
      </div>
      <button
        className="fixed bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border bg-background px-4 py-2 text-sm font-medium shadow-lg lg:hidden"
        onClick={() => setEditorMode('editor')}
        type="button"
      >
        Back to editor
      </button>
    </main>
  );

  const codeCanvas = (
    <main
      aria-label="Event page JSON"
      className="min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/30"
      data-testid="editor-canvas"
    >
      <div className="h-full overflow-auto p-5">
        <pre className="rounded-md border bg-background p-4 text-xs leading-5">
          {JSON.stringify(eventPageDocument, null, 2)}
        </pre>
      </div>
      <button
        className="fixed bottom-4 left-1/2 z-30 -translate-x-1/2 rounded-full border bg-background px-4 py-2 text-sm font-medium shadow-lg lg:hidden"
        onClick={() => setEditorMode('editor')}
        type="button"
      >
        Back to editor
      </button>
    </main>
  );

  const canvas =
    editorMode === 'editor' ? editorCanvas : editorMode === 'preview' ? previewCanvas : codeCanvas;

  const secondaryActions = (
    <>
      <div className="flex rounded-md border bg-muted/40 p-0.5">
        <button
          aria-pressed={editorMode === 'editor'}
          className={`rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
            editorMode === 'editor'
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground'
          }`}
          onClick={() => setEditorMode('editor')}
          type="button"
        >
          Edit
        </button>
        <button
          aria-pressed={editorMode === 'preview'}
          className={`rounded px-2.5 py-1.5 text-xs font-medium transition-colors ${
            editorMode === 'preview'
              ? 'bg-background text-foreground shadow-xs'
              : 'text-muted-foreground'
          }`}
          onClick={openPreview}
          type="button"
        >
          Preview
        </button>
      </div>
      {editorMode === 'preview' ? (
        <div aria-label="Preview device" className="flex rounded-md border p-0.5">
          {(
            [
              ['desktop', LayoutTemplate],
              ['tablet', Tablet],
              ['mobile', Smartphone],
            ] as const
          ).map(([viewport, Icon]) => (
            <button
              aria-label={`${viewport} preview`}
              aria-pressed={previewViewport === viewport}
              className={`rounded p-1.5 transition-colors ${
                previewViewport === viewport
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted-foreground'
              }`}
              key={viewport}
              onClick={() => setPreviewViewport(viewport)}
              type="button"
            >
              <Icon className="size-3.5" />
            </button>
          ))}
        </div>
      ) : null}
      {editorMode === 'editor' ? (
        <>
          <EventPagePanelToggle
            icon={
              structurePanelOpen ? (
                <PanelLeftClose className="size-3.5" />
              ) : (
                <PanelLeftOpen className="size-3.5" />
              )
            }
            label="Page builder"
            onClick={() => setStructurePanelOpen((open) => !open)}
            open={structurePanelOpen}
          />
          <EventPagePanelToggle
            icon={
              inspectorOpen ? (
                <PanelRightClose className="size-3.5" />
              ) : (
                <PanelRightOpen className="size-3.5" />
              )
            }
            label="Settings"
            onClick={() => setInspectorOpen((open) => !open)}
            open={inspectorOpen}
          />
        </>
      ) : null}
      <button
        className={`inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-xs font-medium transition-colors ${
          localValidation.valid
            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700'
            : 'border-destructive/30 bg-destructive/10 text-destructive'
        }`}
        onClick={() => requestPublishReview()}
        type="button"
      >
        {localValidation.valid ? (
          <CheckCircle2 className="size-3.5" />
        ) : (
          <CircleHelp className="size-3.5" />
        )}
        {localValidation.valid ? 'Ready' : `${localValidation.issues.length} issues`}
      </button>
    </>
  );

  const topBar = (
    <EditorTopBar
      autosave={autosave}
      autosaveLabel={autosaveLabel}
      backHref={`/events/${event.id}`}
      channelLabel="Page"
      documentName={document.name}
      error={actionError}
      moreActions={moreActionsItems}
      onBackClick={(clickEvent: React.MouseEvent<HTMLAnchorElement>) =>
        void saveBeforeBackNavigation(clickEvent)
      }
      onDocumentNameClick={canEdit ? () => setRenameOpen(true) : undefined}
      notice={notice}
      onPublish={() => requestPublishReview()}
      publishDisabled={publishDisabled}
      secondaryActions={secondaryActions}
      status={document.status}
    />
  );

  const renderChrome = () => (
    <EditorChrome
      channel="event-page"
      testId="content-editor-shell"
      topBar={topBar}
      leftRail={null}
      canvas={canvas}
      inspector={null}
    />
  );

  return (
    <>
      <div className="contents" inert={publishReviewOpen}>
        {editorMode === 'editor' ? (
          <Puck
            config={puckConfig}
            data={eventPageDocument.editor.data as EventPagePuckCoreData}
            height="100svh"
            iframe={eventPagePuckIframeConfig}
            key={`${document.id}:${puckSessionRevision}`}
            onChange={(data) => setCurrentPuckData(data)}
            onPublish={(data) => {
              if (!eventPageDocument || !event) return;
              const nextDocument = withPuckData(eventPageDocument, data, event);
              setEventPageDocument(nextDocument);
              requestPublishReview(nextDocument);
            }}
            overrides={overrides}
            permissions={permissions}
            viewports={eventPageViewports}
          >
            <SelectFirstPuckBlockOnMount
              documentId={document.id}
              hasContent={eventPageDocument.editor.data.content.length > 0}
            />
            <FocusEventPageTarget onFocused={() => setFocusTarget(null)} target={focusTarget} />
            {renderChrome()}
          </Puck>
        ) : (
          renderChrome()
        )}
        {archivedReason && (
          <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-md border bg-background px-3 py-2 text-xs text-muted-foreground shadow-sm">
            {archivedReason}
          </div>
        )}
        {actionError && !publishReviewOpen ? (
          <div
            className="fixed inset-x-3 top-[68px] z-50 flex items-start justify-between gap-3 rounded-md border border-destructive/30 bg-background px-3 py-2 text-sm text-destructive shadow-lg lg:hidden"
            role="alert"
          >
            <span>{actionError}</span>
            <button
              aria-label="Dismiss error"
              className="inline-flex size-6 shrink-0 items-center justify-center rounded hover:bg-destructive/10"
              onClick={() => setActionError(undefined)}
              type="button"
            >
              <X className="size-3.5" />
            </button>
          </div>
        ) : null}
      </div>
      {publishReviewOpen && preview && (
        <PublishReviewDrawer
          brand={editorChrome.brand}
          draft={draft}
          error={actionError}
          onClose={() => {
            if (!isPublishing) setPublishReviewOpen(false);
          }}
          onEditIssue={editValidationIssue}
          onPublish={(snapshot) => void publishDraft(snapshot)}
          preview={preview}
          publicUrl={publicPageUrl(eventPageDocument, event)}
          publishing={isPublishing}
          runtime={pageRuntime}
          status={document.status}
        />
      )}
      {renameOpen ? (
        <RenameEventPageDialog
          currentName={document.name}
          error={actionError}
          onClose={() => {
            if (!isRenaming) {
              setRenameOpen(false);
              setActionError(undefined);
            }
          }}
          onSave={(name) => void renameDocument(name)}
          saving={isRenaming}
        />
      ) : null}
      {historyOpen ? (
        <EventPageVersionHistoryDialog
          canRestore={canEdit}
          currentDocument={eventPageDocument}
          currentDraftId={draft.id}
          error={actionError}
          onClose={() => setHistoryOpen(false)}
          onPreview={previewVersion}
          onRestore={restoreVersion}
          versions={versions}
        />
      ) : null}
      {dataDialogOpen ? (
        <EventPageDataDialog
          event={event}
          onClose={() => setDataDialogOpen(false)}
          productCount={editorChrome.products.length}
          ticketCount={pageRuntime.tickets.length}
        />
      ) : null}
    </>
  );
}
