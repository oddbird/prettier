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
import {
  DOC_TYPE_FILL,
  DOC_TYPE_GROUP,
  DOC_TYPE_INDENT,
} from "../document/constants.js";
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

/**
 * @import {Doc} from "../document/builders.js"
 */

function shouldBreakList(path) {
  return path.match(
    (node) =>
      // TODO: This originally found any children that are more than a
      // single expression. Maybe this should target any expression?
      node.some?.((node) =>
        ["list", "binary-operation"].includes(node.sassType),
      ),
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
    // !(
    //   path.node.type === "value-comma_group" &&
    //   path.node.groups.every((group) => group.type === "value-comment")
    // ) &&
    shouldPrintTrailingComma(options) &&
    // path.callParent(() => isSCSSMapItemNode(path, options))
    options.parser === "scss" &&
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
      return [node.toString(), hardline];

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
            isTemplatePropNode(node) &&
              !parentNode.raws.semicolon &&
              options.originalText[locEnd(node) - 1] !== ";"
            ? ""
            : options.__isHTMLStyleAttribute && path.isLast
              ? ifBreak(";")
              : ";",
      ];
    }

    case "function-rule":
    case "return-rule":
    case "mixin-rule":
    case "include-rule":
    case "atrule": {
      const parentNode = path.parent;
      const isTemplatePlaceholderNodeWithoutSemiColon =
        isTemplatePlaceholderNode(node) &&
        !parentNode.raws.semicolon &&
        options.originalText[locEnd(node) - 1] !== ";";

      const isImportEndsWithSemiColon =
        node.name === "import" && node.params.endsWith(";");

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
        node.params
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
              // TODO: `node.params` should be parsed so they can be formatted
              // print("params"),
              node.params.trim(),
            ]
          : "",
        // TODO: Can at-rules have a selector? `@extend`?
        node.selector ? indent([" ", print("selector")]) : "",
        node.value
          ? group([
              " ",
              print("value"),
              isSCSSControlDirectiveNode(node, options)
                ? hasParensAroundNode(node)
                  ? " "
                  : line
                : "",
            ])
          : node.name === "else"
            ? " "
            : "",
        node.nodes
          ? [
              isSCSSControlDirectiveNode(node, options)
                ? ""
                : (node.selector &&
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
          : isTemplatePlaceholderNodeWithoutSemiColon ||
              isImportEndsWithSemiColon
            ? ""
            : ";",
      ];
    }

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

    case "argument": {
      const printed = [
        node.name === undefined
          ? ""
          : "$" +
            (node.raws.name?.value === node.name
              ? node.raws.name.raw
              : // : sassInternal.toCssIdentifier(node.name)) +
                node.name) +
            group([node.raws.between ?? ":", line]),
        print("value"),
        node.rest ? (node.raws.beforeRest ?? "") + "..." : "",
      ];
      /** @type {Doc[]} */
      const parts = [""];
      for (let i = 0; i < printed.length; ++i) {
        parts.push([parts.pop(), printed[i]]);
      }
      return group(indent(fill(parts)));
    }

    case "map-entry": {
      const printed = [
        print("key"),
        group([node.raws.between ?? ":", line]),
        print("value"),
      ];
      /** @type {Doc[]} */
      const parts = [""];
      for (let i = 0; i < printed.length; ++i) {
        parts.push([parts.pop(), printed[i]]);
      }
      return group(indent(fill(parts)));
    }

    case "map":
    case "argument-list":
    case "list": {
      // console.log(node);
      const parentNode = path.parent;
      const hasParens =
        parentNode.sassType === "parenthesized" ||
        node.sassType === "argument-list" ||
        node.sassType === "map";
      // console.log(node);
      const nodeDocs = path.map(
        ({ node }) => (typeof node === "string" ? node : print()),
        "nodes",
      );
      // console.log(nodeDocs);

      if (!hasParens) {
        const forceHardLine = shouldBreakList(path);
        assertDocArray(nodeDocs);
        const separator = (node.separator ?? "").trim();
        const withSeparator = chunk(join(separator, nodeDocs), 2);
        const parts = join(forceHardLine ? hardline : line, withSeparator);
        return indent(
          forceHardLine
            ? [hardline, parts]
            : group([parentNode.type === "decl" ? softline : "", fill(parts)]),
        );
      }
      // console.log(nodeDocs);
      const parts = path.map(({ node: child, isLast, index }) => {
        let doc = nodeDocs[index];
        // if (child.sassType === "argument") {
        //   console.log(doc);
        // }
        // console.log(doc);
        // console.log(getDocType(doc.contents));
        // console.log(getDocType(doc.contents.contents));
        // Key/Value pair in open paren already indented
        if (
          (child.sassType === "map-entry" || child.sassType === "argument") &&
          !["parenthesized", "argument-list", "map"].includes(
            child.key?.sassType,
          ) &&
          ["parenthesized", "argument-list", "map"].includes(
            child.value.sassType,
          ) &&
          getDocType(doc) === DOC_TYPE_GROUP &&
          getDocType(doc.contents) === DOC_TYPE_INDENT &&
          getDocType(doc.contents.contents) === DOC_TYPE_FILL
        ) {
          console.log("YES");
          doc = group(dedent(doc));
        }

        const parts = [doc, isLast ? printTrailingComma(path, options) : ","];
        // console.log(parts);

        if (
          !isLast &&
          ["map", "list", "argument-list"].includes(child.sassType) &&
          isNonEmptyArray(child.nodes)
        ) {
          const { last } = child;

          if (
            last.source &&
            isNextLineEmpty(options.originalText, locEnd(last))
          ) {
            parts.push(hardline);
          }
        }

        return parts;
      }, "nodes");
      const isKey =
        parentNode.sassType === "map-entry" && parentNode.key === node;
      const isSCSSMapItem = parentNode.sassType === "map";
      const shouldBreak = isSCSSMapItem && !isKey;
      const shouldDedent = isKey;

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
      // TODO: This doesn't seem to be implemented in sass-parser
      if (node.raws?.value?.value === node.value) {
        return [printCssNumber(node.raws.value.raw), unit];
      }
      return [printCssNumber(node.value.toString()), unit];
    }

    case "color": {
      const text = node.value.toString();
      if (/^#.+/u.test(text)) {
        return text.toLowerCase();
      }
      return text;
    }

    case "binary-operation":
      return group([print("left"), " ", node.operator, " ", print("right")]);

    case "parenthesized":
      return group(["(", indent([softline, print("inParens")]), softline, ")"]);

    case "selector-expr":
    case "variable":
      return node.toString();

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
      console.error(node);
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
