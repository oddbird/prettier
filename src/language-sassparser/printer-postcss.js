import {
  dedent,
  fill,
  group,
  hardline,
  ifBreak,
  indent,
  join,
  line,
  softline,
} from "../document/builders.js";
import { DOC_TYPE_GROUP, DOC_TYPE_INDENT } from "../document/constants.js";
import { getDocType, removeLines } from "../document/utils.js";
import { assertDocArray } from "../document/utils/assert-doc.js";
import isNextLineEmpty from "../utils/is-next-line-empty.js";
import isNonEmptyArray from "../utils/is-non-empty-array.js";
import printString from "../utils/print-string.js";
import UnexpectedNodeError from "../utils/unexpected-node-error.js";
import embed from "./embed.js";
import getVisitorKeys from "./get-visitor-keys.js";
import { locEnd, locStart } from "./loc.js";
import { insertPragma } from "./pragma.js";
import {
  printCssNumber,
  printUnit,
  shouldPrintTrailingComma,
} from "./print/misc.js";
import printSequence from "./print/sequence.js";
import { chunk } from "./utils/chunk.js";
import {
  hasComposesNode,
  hasParensAroundNode,
  insideICSSRuleNode,
  isDetachedRulesetCallNode,
  isDetachedRulesetDeclarationNode,
  isSCSSControlDirectiveNode,
  isTemplatePlaceholderNode,
  isTemplatePropNode,
  isVarFunctionNode,
  isWideKeywords,
  lastLineHasInlineComment,
  maybeToLowerCase,
} from "./utils/index.js";

function isKeyValuePairNode(node) {
  return (
    node.sassType === "map-entry" ||
    node.sassType === "configured-variable" ||
    (node.sassType === "argument" && Boolean(node.name)) ||
    (node.sassType === "parameter" && Boolean(node.defaultValue))
  );
}

function isCommaGroup(node) {
  return (
    [
      "argument-list",
      "parameter-list",
      "parameter",
      "binary-operation",
      "function-call",
      "list",
      "map",
      "configuration",
      "parenthesized",
      "unary-operation",
    ].includes(node.sassType) || isKeyValuePairNode(node)
  );
}

function shouldBreakList(path) {
  return path.match(
    (node) => node.some?.(isCommaGroup),
    (node, key) =>
      key === "expression" &&
      ((node.type === "decl" && !node.prop.startsWith("--")) ||
        (node.type === "atrule" && node.variable)),
  );
}

function hasComma({ node, parent }, options) {
  return Boolean(
    node.source &&
      options.originalText
        .slice(locStart(node), locStart(parent.close))
        .trimEnd()
        .endsWith(","),
  );
}

function printTrailingComma(path, options) {
  if (isVarFunctionNode(path.grandparent) && hasComma(path, options)) {
    return ",";
  }

  if (
    path.node.type !== "comment" &&
    shouldPrintTrailingComma(options) &&
    path.callParent(() => path.node.sassType === "map")
  ) {
    return ifBreak(",");
  }

  return "";
}

function genericPrint(path, options, print) {
  const { node } = path;

  switch (node.sassType) {
    case "front-matter":
      return [node.raw, hardline];

    case "root": {
      const nodes = printSequence(path, options, print);
      let after = node.raws.after?.trim() ?? "";
      if (after.startsWith(";")) {
        after = after.slice(1).trim();
      }

      return [
        node.frontMatter ? [print("frontMatter"), hardline] : "",
        nodes,
        after ? ` ${after}` : "",
        node.nodes.length > 0 ? hardline : "",
      ];
    }

    case "sass-comment":
    case "comment":
      // TODO: This strips trailing newlines
      return node.toString();

    case "rule":
      return [
        // TODO: Replace this once sass-parser exposes parsed selector node
        // print("selector"),
        node.selector.trim(),
        node.nodes
          ? [
              node.selector ? " " : "",
              "{",
              node.nodes.length > 0
                ? indent([hardline, printSequence(path, options, print)])
                : "",
              hardline,
              "}",
              isDetachedRulesetDeclarationNode(node) ? ";" : "",
            ]
          : ";",
      ];

    case "variable-declaration":
    case "decl": {
      const parentNode = path.parent;
      const { between: rawBetween } = node.raws;
      const trimmedBetween = rawBetween?.trim() ?? ":";
      const isColon = trimmedBetween === ":";
      const isValueAllSpace =
        node.expression === undefined && /^ *$/u.test(node.value);
      let value = node.expression ? print("expression") : node.value;

      value = hasComposesNode(node) ? removeLines(value) : value;

      if (
        !isColon &&
        lastLineHasInlineComment(trimmedBetween) &&
        !(
          node.expression &&
          path.call(() => shouldBreakList(path), "expression")
        )
      ) {
        value = indent([hardline, dedent(value)]);
      }

      return [
        node.raws.before?.replaceAll(/[\s;]/gu, "") ?? "",
        insideICSSRuleNode(path) ? node.prop : maybeToLowerCase(node.prop),
        trimmedBetween.startsWith("//") ? " " : "",
        trimmedBetween,
        isValueAllSpace ? "" : " ",
        value,
        // TODO: using `node.important` throws an error, not yet implemented
        // node.raws.important
        //   ? node.raws.important.replace(/\s*!\s*important/iu, " !important")
        //   : node.important
        //     ? " !important"
        //     : "",
        node.guarded ? " !default" : "",
        node.global ? " !global" : "",
        node.nodes
          ? [
              " {",
              indent([softline, printSequence(path, options, print)]),
              softline,
              "}",
            ]
          : // TODO: Handle `@prettier-placeholder`
            // https://github.com/prettier/prettier/issues/6790
            isTemplatePropNode(node) &&
              !parentNode.raws.semicolon &&
              options.originalText[locEnd(node) - 1] !== ";"
            ? ""
            : options.__isHTMLStyleAttribute && path.isLast
              ? ifBreak(";")
              : ";",
      ];
    }

    case "content-rule":
    case "each-rule":
    case "else-rule":
    case "for-rule":
    case "function-rule":
    case "if-rule":
    case "import-rule":
    case "include-rule":
    case "mixin-rule":
    case "return-rule":
    case "use-rule":
    case "while-rule":
    case "atrule": {
      const parentNode = path.parent;
      const isTemplatePlaceholderNodeWithoutSemiColon =
        isTemplatePlaceholderNode(node) &&
        !parentNode.raws.semicolon &&
        options.originalText[locEnd(node) - 1] !== ";";
      const nameKey = `${node.sassType.split("-")[0]}Name`;

      const params = [];
      let child;
      switch (node.sassType) {
        case "content-rule":
          if (
            node.raws.showArguments ||
            isNonEmptyArray(node.contentArguments)
          ) {
            params.push("contentArguments");
            child = node.contentArguments;
          }
          break;
        case "each-rule":
          if (isNonEmptyArray(node.variables) && node.eachExpression) {
            params.push(
              " ",
              group([
                join(
                  [",", line],
                  node.variables.map(
                    (variable, index) =>
                      `$${variable}${node.raws.afterVariables?.[index] ?? ""}`,
                  ),
                ),
                line,
                "in",
                node.raws.afterIn ?? " ",
              ]),
              print("eachExpression"),
            );
            child = node.eachExpression;
          }
          break;
        case "else-rule":
          if (node.elseCondition) {
            params.push(
              group([" if", node.raws.afterIf ?? line, print("elseCondition")]),
            );
            child = node.elseCondition;
          }
          break;
        case "for-rule":
          params.push(
            " ",
            group([
              `$${node.variable}`,
              node.raws.afterVariable ?? line,
              "from",
              node.raws.afterFrom ?? " ",
              print("fromExpression"),
              node.raws.afterFromExpression ?? line,
              node.to,
              node.raws.afterTo ?? " ",
              print("toExpression"),
            ]),
          );
          break;
        case "function-rule":
          params.push(print("parameters"));
          child = node.parameters;
          break;
        case "if-rule":
          params.push(" ", print("ifCondition"));
          child = node.ifCondition;
          break;
        case "import-rule":
          if (isNonEmptyArray(node.imports.nodes)) {
            params.push(" ", print("imports"));
            child = node.imports;
          }
          break;
        case "include-rule":
          if (
            node.raws.showArguments ||
            isNonEmptyArray(node.arguments.nodes)
          ) {
            params.push(print("arguments"));
            child = node.arguments;
          }
          if (node.using) {
            params.push(
              node.raws.afterArguments ?? line,
              "using",
              node.raws.afterUsing ?? " ",
              print("using"),
            );
            child = node.using;
          }
          break;
        case "mixin-rule":
          if (isNonEmptyArray(node.parameters.nodes)) {
            params.push(print("parameters"));
            child = node.parameters;
          }
          break;
        case "return-rule":
          if (node.returnExpression) {
            params.push(line, print("returnExpression"));
            child = node.returnExpression;
          }
          break;
        case "use-rule":
          params.push(
            " ",
            node.raws.url?.value === node.useUrl
              ? node.raws.url.raw
              : printString('"' + node.useUrl + '"', options),
            node.raws.namespace?.value === node.namespace
              ? node.raws.namespace.raw
              : !node.namespace
                ? " as *"
                : node.defaultNamespace !== node.namespace
                  ? " as " + node.namespace
                  : "",
          );
          if (node.configuration.size > 0) {
            params.push(
              `${node.raws.beforeWith ?? " "}with`,
              `${node.raws.afterWith ?? " "}`,
              print("configuration"),
            );
          }
          break;
        case "while-rule":
          params.push(" ", print("whileCondition"));
          child = node.whileCondition;
          break;
      }

      return [
        "@",
        // If a Less file ends up being parsed with the SCSS parser, Less
        // variable declarations will be parsed as at-rules with params starting
        // with a colon, so keep the original case then.
        isDetachedRulesetCallNode(node) ||
        node.params.startsWith(": ") ||
        isTemplatePlaceholderNode(node)
          ? node.name
          : maybeToLowerCase(node.name),
        node[nameKey]
          ? [
              " ",
              node.namespace
                ? node.raws.namespace?.value === node.namespace
                  ? node.raws.namespace.raw
                  : node.namespace + "."
                : "",
              node.raws[nameKey]?.value === node[nameKey]
                ? node.raws[nameKey].raw
                : node[nameKey],
            ]
          : "",
        // TODO: Should `@extend` at-rules have a parsed "selector"?
        // node.selector ? indent([" ", print("selector")]) : "",
        // Known Sass-specific at-rules have parsed parameters in `nameKey`
        node.sassType !== "atrule" && isNonEmptyArray(params)
          ? isSCSSControlDirectiveNode(node)
            ? group([
                child?.sassType === "parenthesized" ? params : indent(params),
                child && hasParensAroundNode(child) ? " " : line,
              ])
            : group(params)
          : node.sassType === "else-rule"
            ? " "
            : "",
        // Generic CSS at-rules do not have parsed parameters
        node.sassType === "atrule" && node.params
          ? [
              isDetachedRulesetCallNode(node)
                ? ""
                : isTemplatePlaceholderNode(node)
                  ? node.raws.afterName === ""
                    ? ""
                    : node.params.startsWith(": ")
                      ? ""
                      : /^\s*\n\s*\n/u.test(node.raws.afterName)
                        ? [hardline, hardline]
                        : /^\s*\n/u.test(node.raws.afterName)
                          ? hardline
                          : " "
                  : node.params.startsWith(": ")
                    ? ""
                    : " ",
              node.params.trim(),
            ]
          : "",
        node.nodes
          ? [
              isSCSSControlDirectiveNode(node)
                ? ""
                : // TODO: Should `@extend` at-rules have a parsed "selector"?
                  (node.selector &&
                      !node.selector.nodes &&
                      typeof node.selector.value === "string" &&
                      lastLineHasInlineComment(node.selector.value)) ||
                    (!node.selector && lastLineHasInlineComment(node.params))
                  ? line
                  : " ",
              "{",
              indent([
                node.nodes.length > 0 ? softline : "",
                printSequence(path, options, print),
              ]),
              softline,
              "}",
            ]
          : isTemplatePlaceholderNodeWithoutSemiColon
            ? ""
            : ";",
      ];
    }

    case "configured-variable":
      return group(
        indent([
          "$",
          node.raws.name?.value === node.name ? node.raws.name.raw : node.name,
          node.raws.between ?? [":", line],
          print("expression"),
          node.guarded ? [node.raws.beforeGuard ?? " ", "!default"] : "",
        ]),
      );

    case "function-call":
      return [
        node.namespace
          ? (node.raws.namespace?.value === node.namespace
              ? node.raws.namespace.raw
              : node.namespace) + "."
          : "",
        node.raws.name?.value === node.name ? node.raws.name.raw : node.name,
        print("arguments"),
      ];

    case "parameter":
    case "argument":
      return group([
        node.name === undefined
          ? ""
          : [
              "$",
              node.raws.name?.value === node.name
                ? node.raws.name.raw
                : node.name,
              node.sassType !== "parameter" || node.defaultValue
                ? (node.raws.between ?? ":")
                : "",
            ],
        node.defaultValue
          ? [
              hasParensAroundNode(node.defaultValue) ? " " : line,
              print("defaultValue"),
            ]
          : "",
        node.value
          ? node.name === undefined
            ? print("value")
            : hasParensAroundNode(node.value)
              ? [" ", print("value")]
              : indent([line, print("value")])
          : "",
        node.rest ? (node.raws.beforeRest ?? "") + "..." : "",
      ]);

    case "map-entry": {
      const keyDoc = print("key");
      const valueDoc = print("value");
      const between = node.raws.between ?? [":", line];

      return group(indent([keyDoc, between, valueDoc]));
    }

    case "import-list":
      return group(indent([join([",", line], path.map(print, "nodes"))]));

    case "static-import":
      return group([
        print("staticUrl"),
        node.modifiers ? [node.raws.between ?? " ", print("modifiers")] : "",
      ]);

    case "dynamic-import":
      return group([
        node.raws.url?.value === node.url
          ? node.raws.url.raw
          : printString('"' + node.url + '"', options),
      ]);

    case "interpolation":
      return path.map(
        ({ node }) => (typeof node === "string" ? node : print()),
        "nodes",
      );

    case "map":
    case "parameter-list":
    case "argument-list":
    case "list":
    case "configuration": {
      const parentNode = path.parent;
      const hasParens = node.sassType !== "list";

      if (node.sassType === "configuration") {
        node.nodes = [...node.variables()];
      }

      const nodeDocs = path.map(
        ({ node }) => (typeof node === "string" ? node : print()),
        "nodes",
      );

      // Handle lists without parentheses
      if (!hasParens) {
        const forceHardLine = shouldBreakList(path);
        assertDocArray(nodeDocs);
        const separator = (node.separator ?? "").trim();
        const withSeparator = chunk(join(separator, nodeDocs), 2);
        const parts = join(forceHardLine ? hardline : line, withSeparator);
        const doc = forceHardLine
          ? [hardline, parts]
          : group([parentNode.type === "decl" ? softline : "", fill(parts)]);
        const isDirectChildOfEachRule = parentNode.sassType === "each-rule";
        return isDirectChildOfEachRule ? doc : indent(doc);
      }

      // Handle parenthesized lists/maps/arguments
      const parts = path.map(({ node: child, isLast, index }) => {
        let doc = nodeDocs[index];

        // Key/Value pair in open paren - check if it needs dedenting
        // This handles cases like (key: (nested, values)) where the nested part
        // is already indented and we need to dedent to align properly
        if (
          isKeyValuePairNode(child) &&
          child.value &&
          ["parenthesized", "argument-list", "map", "list"].includes(
            child.value.sassType,
          ) &&
          getDocType(doc) === DOC_TYPE_GROUP &&
          isNonEmptyArray(doc.contents) &&
          getDocType(doc.contents[0]) === DOC_TYPE_INDENT
        ) {
          doc = group(dedent(doc));
        }

        const parts = [doc, isLast ? printTrailingComma(path, options) : ","];

        // Add extra line break after comma groups if there's an empty line in original
        if (
          !isLast &&
          isCommaGroup(child) &&
          // TODO: `source` isn't implemented yet in sass-parser
          child.source &&
          isNextLineEmpty(options.originalText, locEnd(child))
        ) {
          parts.push(hardline);
        }

        return parts;
      }, "nodes");

      const isKey =
        parentNode.sassType === "map-entry" && parentNode.key === node;
      const isSCSSMapItem =
        node.sassType === "map" || node.sassType === "configuration";
      const isDirectChildOfEachRule = parentNode.sassType === "each-rule";
      const shouldBreak = isSCSSMapItem && !isKey && !isDirectChildOfEachRule;
      const shouldDedent = isKey || isDirectChildOfEachRule;

      const doc = group(
        [
          hasParens ? "(" : "",
          indent([softline, join(line, parts)]),
          softline,
          hasParens ? ")" : "",
        ],
        {
          shouldBreak,
        },
      );

      return shouldDedent ? dedent(doc) : doc;
    }

    case "number": {
      const unit = printUnit(node.unit ?? "");
      return [
        printCssNumber(
          // TODO: This doesn't seem to be implemented in sass-parser
          node.raws?.value?.value === node.value
            ? node.raws.value.raw
            : node.value.toString(),
        ),
        unit,
      ];
    }

    case "color": {
      const text = node.value.toString();
      if (/^#.+/u.test(text)) {
        return text.toLowerCase();
      }
      return text;
    }

    case "binary-operation": {
      const leftDoc = print("left");
      const rightDoc = print("right");
      const { operator } = node;
      const beforeOperator = node.raws.beforeOperator ?? " ";
      const afterOperator = node.raws.afterOperator ?? " ";

      // For binary operations, determine if we need extra indentation
      // Extra indentation is needed when we're nested inside other constructs like parentheses
      const needsExtraIndent = path.parent.sassType === "parenthesized";

      const parts = [
        leftDoc,
        beforeOperator,
        operator,
        afterOperator === " "
          ? needsExtraIndent
            ? indent(line)
            : line
          : afterOperator,
        rightDoc,
      ];

      // Only group the outermost binary operation
      // This ensures all operations in a chain break together
      const parentIsBinaryOp = path.parent.sassType === "binary-operation";
      return parentIsBinaryOp ? parts : group(parts);
    }

    case "parenthesized":
      return group(["(", indent([softline, print("inParens")]), softline, ")"]);

    case "selector-expr":
    case "variable":
      return node.toString();

    case "boolean":
      return node.value.toString();

    case "null":
      return "null";

    case "string": {
      const text = node.toString().trim();
      if (node.quotes) {
        return printString(text, options);
      }
      if (isWideKeywords(text)) {
        return text.toLowerCase();
      }
      return text;
    }

    case "unknown":
      return node.value;

    default:
      /* c8 ignore next */
      console.error(node.toJSON());
      throw new UnexpectedNodeError(node, "PostCSS", "sassType");
  }
}

const printer = {
  print: genericPrint,
  embed,
  insertPragma,
  getVisitorKeys,
};

export default printer;
