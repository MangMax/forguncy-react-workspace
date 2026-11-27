import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface DesignerPage {
  readonly name: string;
  readonly settings: Record<string, string>;
  readonly cells: readonly { position: string; capabilities: Record<string, string> }[];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function describe(value: unknown): string {
  if (value == null) return "未设置";
  if (Array.isArray(value)) return value.map(describe).join("；") || "无";
  if (typeof value === "object") {
    return (
      Object.entries(record(value))
        .map(([key, entry]) => `${key}：${describe(entry)}`)
        .join("，") || "无"
    );
  }
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "未设置";
}

const capabilityKeys = [
  "属性",
  "事件处理",
  "数据源",
  "权限",
  "可用服务端命令",
  "上传限制",
  "预置类库",
  "前端扩展库",
  "静态图片资源",
];

export async function readDesignerPage(name: string): Promise<DesignerPage> {
  const transport = new StreamableHTTPClientTransport(new URL("http://127.0.0.1:11234/mcp"));
  const client = new Client({ name: "forguncy-inspector", version: "0.1.0" });
  try {
    await client.connect(transport, { timeout: 5000 });
    const result = await client.callTool(
      {
        name: "get_document_content",
        arguments: { documentType: "pages", documentName: name, depth: 9 },
      },
      { timeout: 5000 },
    );
    const block = result.content.find((item) => item.type === "text");
    if (result.isError || !block) throw new Error("无法读取页面，请确认设计器已打开目标工程。");
    const content = record(record(JSON.parse(block.text)).content);
    const rawSettings = content["页面设置"];
    const rawCells = content["单元格"];
    if (!rawSettings || !Array.isArray(rawCells)) throw new Error("没有读到目标页面的配置。");
    const cells = rawCells.flatMap((entry) => {
      const cell = record(entry);
      const type = record(cell["单元格类型"]);
      const position = cell["位置"];
      if (type["类型"] !== "React AI 单元格" || typeof position !== "string") return [];
      const capabilities = Object.fromEntries(
        capabilityKeys.map((key) => [key, describe(type[key])]),
      );
      return [{ position, capabilities }];
    });
    const settings = Object.fromEntries(
      Object.entries(record(rawSettings)).map(([key, value]) => [key, describe(value)]),
    );
    return { name, settings, cells };
  } finally {
    await client.close();
  }
}
