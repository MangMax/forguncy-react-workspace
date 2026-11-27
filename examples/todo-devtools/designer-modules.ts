import type { JsonRenderSpec } from "@vitejs/devtools/json-render";

type Elements = JsonRenderSpec["elements"];
type Values = Record<string, unknown>;

function object(value: unknown): Values {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Values) : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function label(value: unknown): string {
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return String(value);
    default:
      return "—";
  }
}

function records(value: unknown): Values[] {
  return list(value).map(object);
}

export const moduleNames = {
  sources: "数据源",
  commands: "服务端命令",
  permissions: "权限",
  properties: "属性",
  events: "事件",
  libraries: "前端库",
  upload: "上传限制",
  images: "静态图片",
  "page-settings": "页面设置",
  "page-load": "页面加载命令",
} as const;
export type InspectorModule = keyof typeof moduleNames;

export function designerModules(
  elements: Elements,
  prefix: string,
  selected?: InspectorModule,
  overview = true,
) {
  function add(key: string, node: Elements[string]): string {
    const id = `${prefix}-${key}`;
    elements[id] = node;
    return id;
  }

  function text(key: string, value: string, code = false): string {
    return add(key, { type: "Text", props: { text: value, ...(code ? { variant: "code" } : {}) } });
  }

  function group(key: string, children: string[], row = false): string {
    return add(key, {
      type: "Stack",
      props: { gap: 8, direction: row ? "row" : "column", wrap: row },
      children,
    });
  }

  function table(key: string, columns: string[], values: string[][]): string {
    return add(key, {
      type: "DataTable",
      props: {
        columns: columns.map((name, index) => ({ key: String(index), label: name })),
        rows: values.map((row) =>
          Object.fromEntries(row.map((value, index) => [String(index), value])),
        ),
        ...(values.length > 8 ? { height: 240 } : {}),
      },
    });
  }

  function card(key: string, title: string, children: string[], collapsed = false): string {
    return add(key, {
      type: "Card",
      props: { title, collapsible: true, defaultCollapsed: collapsed },
      children,
    });
  }

  function module(key: InspectorModule, summary: string, children: string[]): string {
    const title = moduleNames[key];
    if (!overview)
      return card(key, `${title} · ${summary}`, [group(`${key}-content`, children)], true);
    if (selected === key) return group(key, children);
    if (selected) return "";
    const tile = add(key, {
      type: "Card",
      props: { title },
      children: [
        group(
          `${key}-overview`,
          [
            text(`${key}-summary`, summary),
            add(`${key}-open`, {
              type: "Button",
              props: { label: `查看${title}`, variant: "secondary" },
              on: { press: { action: `forguncy-todo:module-${key}` } },
            }),
          ],
          true,
        ),
      ],
    });
    return add(`${key}-tile`, {
      type: "Stack",
      props: { flex: "1 1 240px" },
      children: [tile],
    });
  }

  function layout(keys: string[]): string[] {
    const visible = keys.filter(Boolean);
    if (selected || !overview) return visible;
    return [
      add("module-grid", {
        type: "Stack",
        props: { direction: "row", wrap: true, gap: 12, align: "stretch" },
        children: visible,
      }),
    ];
  }

  function tokens(key: string, values: unknown[]): string {
    return group(
      key,
      values.map((value, index) => text(`${key}-${index}`, label(value), true)),
      true,
    );
  }

  function commands(key: string, values: Values[]): string[] {
    if (!values.length) return [text(`${key}-empty`, "未配置命令")];
    return [
      table(
        `${key}-table`,
        ["命令类型", "标题", "内容"],
        values.map((value) => [label(value["类型"]), label(value["标题"]), label(value["内容"])]),
      ),
    ];
  }

  function counted(
    key: InspectorModule,
    count: number,
    children: string[],
    summary = `${count} 项`,
  ): string {
    return module(
      key,
      count ? summary : "未配置",
      count ? children : [text(`${key}-empty`, `未配置${moduleNames[key]}`)],
    );
  }

  function cell(capabilities: Values): string[] {
    const sources = records(capabilities["数据源"]);
    const serverCommands = records(capabilities["可用服务端命令"]);
    const permissions = records(capabilities["权限"]);
    const properties = records(capabilities["属性"]);
    const events = records(capabilities["事件处理"]);
    const extensions = records(capabilities["前端扩展库"]);
    const libraries = list(capabilities["预置类库"]);
    const images = records(capabilities["静态图片资源"]);
    const upload = object(capabilities["上传限制"]);
    const showExamples = properties.some((item) => item["示例值"] !== undefined);

    const dataSources = sources.flatMap((item, index) => {
      const binding = object(item["绑定数据源"]);
      const fields = records(binding["选择项"]);
      const policy = binding["值为公式且计算结果为空时的查询策略"];
      return [
        ...(index ? [add(`source-divider-${index}`, { type: "Divider", props: {} })] : []),
        text(
          `source-title-${index}`,
          `${label(item["数据源名称"])} → ${label(binding["数据表"])}`,
          true,
        ),
        ...(fields.length
          ? [
              table(
                `source-fields-${index}`,
                ["输出列", "绑定源"],
                fields.map((field) => [label(field["列名"]), label(field["绑定"])]),
              ),
            ]
          : [text(`source-empty-${index}`, "未返回绑定字段")]),
        ...(policy === undefined
          ? []
          : [text(`source-policy-${index}`, `公式空值策略 · ${label(policy)}`)]),
      ];
    });

    const allowedTypes =
      typeof upload["允许的扩展名"] === "string"
        ? upload["允许的扩展名"]
            .split(",")
            .map((value) => value.trim())
            .filter(Boolean)
        : [];
    const limit = (value: unknown, unit: string) =>
      value === undefined ? "未返回" : value === 0 ? "不限" : `${label(value)} ${unit}`;

    return layout([
      counted(
        "sources",
        sources.length,
        dataSources,
        sources.length === 1
          ? `${label(sources[0]["数据源名称"])} → ${label(object(sources[0]["绑定数据源"])["数据表"])}`
          : `${sources.length} 个数据源`,
      ),
      counted("commands", serverCommands.length, [
        tokens(
          "command-names",
          serverCommands.map((item) => item["服务端命令"]),
        ),
      ]),
      counted("permissions", permissions.length, [
        table(
          "permission-roles",
          ["权限名称", "允许角色"],
          permissions.map((item) => [
            label(item["名称"]),
            list(item["权限设置"]).map(label).join("、") || "未指定",
          ]),
        ),
      ]),
      counted("properties", properties.length, [
        table(
          "property-bindings",
          ["属性名称", "绑定公式", ...(showExamples ? ["示例值"] : [])],
          properties.map((item) => [
            label(item["属性名称"]),
            label(item["属性值"]),
            ...(showExamples ? [label(item["示例值"])] : []),
          ]),
        ),
      ]),
      counted(
        "events",
        events.length,
        events.flatMap((item, index) => {
          const args = records(item["事件参数"]).map((arg) => label(arg["参数名称"]));
          const attached = records(item["执行命令"]);
          return [
            text(
              `event-signature-${index}`,
              `${label(item["事件名称"])}(${args.join(", ")})`,
              true,
            ),
            ...commands(`event-${index}`, attached),
          ];
        }),
      ),
      module("libraries", `${libraries.length} 个预置类库 · ${extensions.length} 个扩展库`, [
        text("preset-label", "预置类库"),
        libraries.length ? tokens("presets", libraries) : text("no-presets", "未配置"),
        text("extension-label", "前端扩展库"),
        extensions.length
          ? tokens(
              "extensions",
              extensions.map((item) => item["前端扩展库"]),
            )
          : text("no-extensions", "未配置"),
      ]),
      module(
        "upload",
        allowedTypes.length ? `${allowedTypes.length} 种文件类型` : "未返回文件类型",
        [
          table(
            "upload-limits",
            ["单文件上限", "单次文件数"],
            [[limit(upload["最大大小 (MB)"], "MB"), limit(upload["单次上传最大文件数"], "个")]],
          ),
          allowedTypes.length
            ? tokens("upload-types", allowedTypes)
            : text("upload-types", "未返回文件类型"),
        ],
      ),
      ...(images.length
        ? [
            module("images", `${images.length} 项`, [
              table(
                "image-list",
                ["图片资源"],
                images.map((image) => [label(image["图片名称"] ?? image["名称"] ?? image["图片"])]),
              ),
            ]),
          ]
        : []),
    ]);
  }

  function page(settings: Values): string[] {
    const { 页面加载命令: loadCommands, ...rest } = settings;
    const load = records(loadCommands);
    const basic = Object.entries(rest).filter(
      ([, value]) => value == null || typeof value !== "object",
    );
    const roles = list(rest["页面权限"]);
    const style = object(rest["样式"]);
    return layout([
      module("page-settings", label(rest["标题"] ?? "页面属性和访问权限"), [
        table(
          "page-fields",
          ["设置项", "值"],
          basic.map(([key, value]) => [key, label(value)]),
        ),
        ...(roles.length
          ? [text("page-roles-label", "访问权限"), tokens("page-roles", roles)]
          : []),
        ...(Object.keys(style).length
          ? [
              card(
                "page-style",
                "页面样式",
                [
                  table(
                    "page-style-fields",
                    ["设置项", "值"],
                    Object.entries(style).map(([key, value]) => [key, label(value)]),
                  ),
                ],
                true,
              ),
            ]
          : []),
      ]),
      module(
        "page-load",
        load.length ? `${load.length} 条命令` : "未配置",
        commands("page-load", load),
      ),
    ]);
  }

  return { cell, page };
}
