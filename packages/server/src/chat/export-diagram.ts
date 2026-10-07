import { createCanvas } from '@napi-rs/canvas';

export interface RenderedDiagram {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly description: string;
}

interface DiagramNode {
  readonly id: string;
  readonly label: string;
}

interface DiagramEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string | null;
}

const cleanLabel = (value: string): string =>
  value
    .replace(/^['"]|['"]$/gu, '')
    .replace(/[<>]/gu, '')
    .trim()
    .slice(0, 100);

const nodePart =
  /^([A-Za-z][A-Za-z0-9_]{0,39})(?:\[([^\]]{1,200})\]|\(([^)]{1,200})\)|\{([^}]{1,200})\})?$/u;

const parsePart = (value: string): DiagramNode | null => {
  const match = nodePart.exec(value.trim());
  if (match === null) return null;
  const id = match[1] as string;
  return { id, label: cleanLabel(match[2] ?? match[3] ?? match[4] ?? id) };
};

const parseDiagram = (
  source: string,
): {
  readonly direction: 'TD' | 'LR';
  readonly nodes: readonly DiagramNode[];
  readonly edges: readonly DiagramEdge[];
} | null => {
  const lines = source
    .replaceAll('\r', '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('%%'));
  const header = /^(?:flowchart|graph)\s+(TD|TB|LR)$/iu.exec(lines.shift() ?? '');
  if (header === null) return null;
  const direction = header[1]?.toUpperCase() === 'LR' ? 'LR' : 'TD';
  const nodes = new Map<string, DiagramNode>();
  const edges: DiagramEdge[] = [];
  const remember = (node: DiagramNode): void => {
    const existing = nodes.get(node.id);
    if (existing === undefined || existing.label === existing.id) nodes.set(node.id, node);
  };
  for (const line of lines) {
    const edge = /^(.+?)\s*--(?:\|([^|]{1,100})\|)?>\s*(.+)$/u.exec(line);
    if (edge !== null) {
      const from = parsePart(edge[1] ?? '');
      const to = parsePart(edge[3] ?? '');
      if (from === null || to === null) return null;
      remember(from);
      remember(to);
      edges.push({ from: from.id, to: to.id, label: edge[2] ? cleanLabel(edge[2]) : null });
      continue;
    }
    const node = parsePart(line);
    if (node === null) return null;
    remember(node);
  }
  if (nodes.size < 1 || nodes.size > 30 || edges.length > 60) return null;
  return { direction, nodes: [...nodes.values()], edges };
};

const wrapLabel = (label: string): readonly string[] => {
  const words = label.split(/\s+/u);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (`${line} ${word}`.trim().length <= 24) line = `${line} ${word}`.trim();
    else {
      if (line.length > 0) lines.push(line);
      line = word.slice(0, 24);
    }
  }
  if (line.length > 0) lines.push(line);
  return lines.slice(0, 3);
};

export const renderMermaidDiagram = (source: string): RenderedDiagram | null => {
  const parsed = parseDiagram(source);
  if (parsed === null) return null;
  const horizontal = parsed.direction === 'LR';
  const nodeWidth = 240;
  const nodeHeight = 92;
  const gap = horizontal ? 110 : 54;
  const margin = 56;
  const width = horizontal
    ? margin * 2 + parsed.nodes.length * nodeWidth + (parsed.nodes.length - 1) * gap
    : 920;
  const height = horizontal
    ? 260
    : margin * 2 + parsed.nodes.length * nodeHeight + (parsed.nodes.length - 1) * gap;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, width, height);
  const positions = new Map<string, { x: number; y: number }>();
  parsed.nodes.forEach((node, index) => {
    const x = horizontal ? margin + index * (nodeWidth + gap) : (width - nodeWidth) / 2;
    const y = horizontal ? (height - nodeHeight) / 2 : margin + index * (nodeHeight + gap);
    positions.set(node.id, { x, y });
  });
  context.strokeStyle = '#315f52';
  context.fillStyle = '#315f52';
  context.lineWidth = 3;
  for (const edge of parsed.edges) {
    const from = positions.get(edge.from);
    const to = positions.get(edge.to);
    if (from === undefined || to === undefined) continue;
    const startX = horizontal ? from.x + nodeWidth : from.x + nodeWidth / 2;
    const startY = horizontal ? from.y + nodeHeight / 2 : from.y + nodeHeight;
    const endX = horizontal ? to.x : to.x + nodeWidth / 2;
    const endY = horizontal ? to.y + nodeHeight / 2 : to.y;
    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(endX, endY);
    context.stroke();
    const angle = Math.atan2(endY - startY, endX - startX);
    context.beginPath();
    context.moveTo(endX, endY);
    context.lineTo(
      endX - 14 * Math.cos(angle - Math.PI / 6),
      endY - 14 * Math.sin(angle - Math.PI / 6),
    );
    context.lineTo(
      endX - 14 * Math.cos(angle + Math.PI / 6),
      endY - 14 * Math.sin(angle + Math.PI / 6),
    );
    context.closePath();
    context.fill();
    if (edge.label !== null) {
      context.fillStyle = '#1d302a';
      context.font = '18px sans-serif';
      context.textAlign = 'center';
      context.fillText(edge.label, (startX + endX) / 2, (startY + endY) / 2 - 8);
      context.fillStyle = '#315f52';
    }
  }
  for (const node of parsed.nodes) {
    const position = positions.get(node.id) as { x: number; y: number };
    context.beginPath();
    context.roundRect(position.x, position.y, nodeWidth, nodeHeight, 12);
    context.fillStyle = '#edf7f3';
    context.fill();
    context.strokeStyle = '#315f52';
    context.stroke();
    context.fillStyle = '#13221e';
    context.font = '20px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    const lines = wrapLabel(node.label);
    lines.forEach((line, index) => {
      context.fillText(
        line,
        position.x + nodeWidth / 2,
        position.y + nodeHeight / 2 + (index - (lines.length - 1) / 2) * 24,
      );
    });
  }
  return {
    bytes: canvas.toBuffer('image/png'),
    width,
    height,
    description: `Mermaid ${parsed.direction} flowchart with ${String(parsed.nodes.length)} nodes and ${String(parsed.edges.length)} edges`,
  };
};
