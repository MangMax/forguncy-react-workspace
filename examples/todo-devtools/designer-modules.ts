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

export function designerModules(elements: Elements, prefix: string) {
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
        ["命令类型", "标题或说明"],
        values.map((value) => [label(value["类型"]), label(value["标题"] ?? value["内容"])]),
      ),
      card(
        `${key}-details`,
        "命令详情",
        [add(`${key}-tree`, { type: "Tree", props: { data: values, defaultExpanded: false } })],
        true,
      ),
    ];
  }

  function counted(key: string, title: string, count: number, children: string[]): string {
    return card(
      key,
      `${title} · ${count || "无"}`,
      count ? children : [text(`${key}-empty`, `未配置${title}`)],
      !count,
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

    return [
      counted("sources", "数据源", sources.length, dataSources),
      counted("commands", "服务端命令", serverCommands.length, [
        tokens(
          "command-names",
          serverCommands.map((item) => item["服务端命令"]),
        ),
      ]),
      counted("permissions", "权限", permissions.length, [
        table(
          "permission-roles",
          ["权限名称", "允许角色"],
          permissions.map((item) => [
            label(item["名称"]),
            list(item["权限设置"]).map(label).join("、") || "未指定",
          ]),
        ),
      ]),
      counted("properties", "属性", properties.length, [
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
        "事件",
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
      card("libraries", extensions.length ? `前端库 · ${extensions.length} 个扩展库` : "前端库", [
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
      card(
        "upload",
        allowedTypes.length ? `上传限制 · ${allowedTypes.length} 种文件类型` : "上传限制",
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
        !Object.keys(upload).length,
      ),
      ...(images.length
        ? [
            card(
              "images",
              `静态图片 · ${images.length}`,
              [
                add("image-list", {
                  type: "Tree",
                  props: { data: images, defaultExpanded: false },
                }),
              ],
              true,
            ),
          ]
        : []),
    ];
  }

  function page(settings: Values): string[] {
    const { 页面加载命令: loadCommands, ...rest } = settings;
    const load = records(loadCommands);
    const basic = Object.entries(rest).filter(
      ([, value]) => value == null || typeof value !== "object",
    );
    const advanced = Object.fromEntries(
      Object.entries(rest).filter(([, value]) => value && typeof value === "object"),
    );
    return [
      card("page-settings", "页面设置", [
        table(
          "page-fields",
          ["设置项", "值"],
          basic.map(([key, value]) => [key, label(value)]),
        ),
        ...(Object.keys(advanced).length
          ? [
              card(
                "page-advanced",
                "权限与样式",
                [
                  add("page-advanced-values", {
                    type: "Tree",
                    props: { data: advanced, defaultExpanded: false },
                  }),
                ],
                true,
              ),
            ]
          : []),
      ]),
      card(
        "page-load",
        `页面加载命令 · ${load.length || "无"}`,
        commands("page-load", load),
        !load.length,
      ),
    ];
  }

  return { cell, page };
}
