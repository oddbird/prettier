import {
  breakParent,
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
import { removeLines } from "../document/utils.js";
import { assertDocArray } from "../document/utils/assert-doc.js";
import isNonEmptyArray from "../utils/is-non-empty-array.js";
import printString from "../utils/print-string.js";
import UnexpectedNodeError from "../utils/unexpected-node-error.js";
import clean from "./clean.js";
import embed from "./embed.js";
import getVisitorKeys from "./get-visitor-keys.js";
import { locEnd, locStart } from "./loc.js";
import { insertPragma } from "./pragma.js";
import {
  adjustNumbers,
  adjustStrings,
  printCssNumber,
  printUnit,
  quoteAttributeValue,
} from "./print/misc.js";
import { chunk, shouldBreakList } from "./print/parenthesized-value-group.js";
import printSequence from "./print/sequence.js";
import {
  hasComposesNode,
  hasParensAroundNode,
  insideAtRuleNode,
  insideICSSRuleNode,
  isDetachedRulesetCallNode,
  isDetachedRulesetDeclarationNode,
  isInlineValueCommentNode,
  isKeyframeAtRuleKeywords,
  isSCSSControlDirectiveNode,
  isTemplatePlaceholderNode,
  isTemplatePropNode,
  isURLFunctionNode,
  isWideKeywords,
  lastLineHasInlineComment,
  maybeToLowerCase,
} from "./utils/index.js";

function genericPrint(path, options, print) {
  const { node } = path;

  // TODO: Do we want to *just* check for `sassType`?
  switch (node.type ?? node.sassType) {
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
    case "comment": {
      const text = options.originalText.slice(locStart(node), locEnd(node));

      return isInlineValueCommentNode(node) ? text.trimEnd() : text;
    }
    case "rule":
      return [
        print("selectorTemp"),
        node.important ? " !important" : "",
        node.nodes
          ? [
              node.selectorTemp?.type === "selector-unknown" &&
              lastLineHasInlineComment(node.selectorTemp.value)
                ? line
                : node.selectorTemp
                  ? " "
                  : "",
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

    case "decl": {
      const parentNode = path.parent;
      const { between: rawBetween } = node.raws;
      const trimmedBetween = rawBetween?.trim() ?? ":";
      const isColon = trimmedBetween === ":";
      let value = node.expression ? print("expression") : node.value;
      const isValueAllSpace =
        typeof node.value === "string" && /^ *$/u.test(value);

      value = hasComposesNode(node) ? removeLines(value) : value;

      // TODO: Haven't checked this path yet
      if (
        !isColon &&
        lastLineHasInlineComment(trimmedBetween) &&
        !(
          node.value?.group?.group &&
          path.call(() => shouldBreakList(path), "value", "group", "group")
        )
      ) {
        value = indent([hardline, dedent(value)]);
      }

      return [
        node.raws.before?.replaceAll(/[\s;]/gu, "") ?? "",
        // Less variable
        (parentNode.type === "atrule" && parentNode.variable) ||
        insideICSSRuleNode(path)
          ? node.prop
          : maybeToLowerCase(node.prop),
        trimmedBetween.startsWith("//") ? " " : "",
        trimmedBetween,
        node.extend || isValueAllSpace ? "" : " ",
        options.parser === "less" && node.extend && node.selectorTemp
          ? ["extend(", print("selectorTemp"), ")"]
          : "",
        value,
        // TODO: using `node.important` throws an error, not yet implemented
        // node.raws.important
        //   ? node.raws.important.replace(/\s*!\s*important/iu, " !important")
        //   : node.important
        //     ? " !important"
        //     : "",
        node.raws.scssDefault
          ? node.raws.scssDefault.replace(/\s*!default/iu, " !default")
          : node.scssDefault
            ? " !default"
            : "",
        node.raws.scssGlobal
          ? node.raws.scssGlobal.replace(/\s*!global/iu, " !global")
          : node.scssGlobal
            ? " !global"
            : "",
        node.nodes
          ? [
              " {",
              indent([softline, printSequence(path, options, print)]),
              softline,
              "}",
            ]
          : isTemplatePropNode(node) &&
              !parentNode.raws.semicolon &&
              options.originalText[locEnd(node) - 1] !== ";"
            ? ""
            : options.__isHTMLStyleAttribute && path.isLast
              ? ifBreak(";")
              : ";",
      ];
    }
    case "atrule": {
      const parentNode = path.parent;
      const isTemplatePlaceholderNodeWithoutSemiColon =
        isTemplatePlaceholderNode(node) &&
        !parentNode.raws.semicolon &&
        options.originalText[locEnd(node) - 1] !== ";";

      if (options.parser === "less") {
        if (node.mixin) {
          return [
            print("selectorTemp"),
            node.important ? " !important" : "",
            isTemplatePlaceholderNodeWithoutSemiColon ? "" : ";",
          ];
        }

        if (node.function) {
          return [
            node.name,
            typeof node.params === "string" ? node.params : print("params"),
            isTemplatePlaceholderNodeWithoutSemiColon ? "" : ";",
          ];
        }

        if (node.variable) {
          return [
            "@",
            node.name,
            ": ",
            node.value ? print("value") : "",
            node.raws.between.trim() ? node.raws.between.trim() + " " : "",
            node.nodes
              ? [
                  "{",
                  indent([
                    node.nodes.length > 0 ? softline : "",
                    printSequence(path, options, print),
                  ]),
                  softline,
                  "}",
                ]
              : "",
            isTemplatePlaceholderNodeWithoutSemiColon ? "" : ";",
          ];
        }
      }
      const isImportUnknownValueEndsWithSemiColon =
        node.name === "import" &&
        node.params?.type === "unknown" &&
        node.params.value.endsWith(";");

      return [
        "@",
        // If a Less file ends up being parsed with the SCSS parser, Less
        // variable declarations will be parsed as at-rules with names ending
        // with a colon, so keep the original case then.
        isDetachedRulesetCallNode(node) ||
        node.name.endsWith(":") ||
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
                    : node.name.endsWith(":")
                      ? " "
                      : /^\s*\n\s*\n/u.test(node.raws.afterName)
                        ? [hardline, hardline]
                        : /^\s*\n/u.test(node.raws.afterName)
                          ? hardline
                          : " "
                  : " ",
              typeof node.params === "string" ? node.params : print("params"),
            ]
          : "",
        node.selectorTemp ? indent([" ", print("selectorTemp")]) : "",
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
                : (node.selectorTemp &&
                      !node.selectorTemp.nodes &&
                      typeof node.selectorTemp.value === "string" &&
                      lastLineHasInlineComment(node.selectorTemp.value)) ||
                    (!node.selectorTemp &&
                      typeof node.params === "string" &&
                      lastLineHasInlineComment(node.params))
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
              isImportUnknownValueEndsWithSemiColon
            ? ""
            : ";",
      ];
    }
    // postcss-media-query-parser
    case "media-query-list": {
      const parts = [];
      path.each(({ node }) => {
        if (node.type === "media-query" && node.value === "") {
          return;
        }
        parts.push(print());
      }, "nodes");

      return group(indent(join(line, parts)));
    }
    case "media-query":
      return [join(" ", path.map(print, "nodes")), path.isLast ? "" : ","];

    case "media-type":
      return adjustNumbers(adjustStrings(node.value, options));

    case "media-feature-expression":
      if (!node.nodes) {
        return node.value;
      }
      return ["(", ...path.map(print, "nodes"), ")"];

    case "media-feature":
      return maybeToLowerCase(
        adjustStrings(node.value.replaceAll(/ +/gu, " "), options),
      );

    case "media-colon":
      return [node.value, " "];

    case "media-value":
      return adjustNumbers(adjustStrings(node.value, options));

    case "media-keyword":
      return adjustStrings(node.value, options);

    case "media-url":
      return adjustStrings(
        node.value
          .replaceAll(/^url\(\s+/giu, "url(")
          .replaceAll(/\s+\)$/gu, ")"),
        options,
      );

    case "media-unknown":
      return node.value;

    // postcss-selector-parser
    case "selector-root":
      return group([
        insideAtRuleNode(path, "custom-selector")
          ? [
              path.findAncestor((node) => node.type === "atrule")
                .customSelector,
              line,
            ]
          : "",
        join(
          [
            ",",
            insideAtRuleNode(path, ["extend", "custom-selector", "nest"])
              ? line
              : hardline,
          ],
          path.map(print, "nodes"),
        ),
      ]);

    case "selector-selector": {
      const shouldIndent = node.nodes.length > 1;
      return group(
        (shouldIndent ? indent : (x) => x)(path.map(print, "nodes")),
      );
    }

    case "selector-comment":
      return node.value;

    case "selector-string":
      return adjustStrings(node.value, options);

    case "selector-tag":
      return [
        node.namespace
          ? [node.namespace === true ? "" : node.namespace.trim(), "|"]
          : "",
        path.previous?.type === "selector-nesting"
          ? node.value
          : adjustNumbers(
              isKeyframeAtRuleKeywords(path, node.value)
                ? node.value.toLowerCase()
                : node.value,
            ),
      ];

    case "selector-id":
      return ["#", node.value];

    case "selector-class":
      return [".", adjustNumbers(adjustStrings(node.value, options))];

    case "selector-attribute":
      return [
        "[",
        node.namespace
          ? [node.namespace === true ? "" : node.namespace.trim(), "|"]
          : "",
        node.attribute.trim(),
        node.operator ?? "",
        node.value
          ? quoteAttributeValue(
              adjustStrings(node.value.trim(), options),
              options,
            )
          : "",
        node.insensitive ? " i" : "",
        "]",
      ];

    case "selector-combinator": {
      if (
        node.value === "+" ||
        node.value === ">" ||
        node.value === "~" ||
        node.value === ">>>"
      ) {
        const parentNode = path.parent;
        const leading =
          parentNode.type === "selector-selector" &&
          parentNode.nodes[0] === node
            ? ""
            : line;

        return [leading, node.value, path.isLast ? "" : " "];
      }

      const leading = node.value.trim().startsWith("(") ? line : "";
      const value =
        adjustNumbers(adjustStrings(node.value.trim(), options)) || line;

      return [leading, value];
    }
    case "selector-universal":
      return [
        node.namespace
          ? [node.namespace === true ? "" : node.namespace.trim(), "|"]
          : "",
        node.value,
      ];

    case "selector-pseudo":
      return [
        maybeToLowerCase(node.value),
        isNonEmptyArray(node.nodes)
          ? group([
              "(",
              indent([softline, join([",", line], path.map(print, "nodes"))]),
              softline,
              ")",
            ])
          : "",
      ];

    case "selector-nesting":
      return node.value;

    case "selector-unknown": {
      const ruleAncestorNode = path.findAncestor(
        (node) => node.type === "rule",
      );

      // Nested SCSS property
      if (ruleAncestorNode?.isSCSSNestedProperty) {
        return adjustNumbers(
          adjustStrings(maybeToLowerCase(node.value), options),
        );
      }

      // originalText has to be used for Less, see replaceQuotesInInlineComments in loc.js
      const parentNode = path.parent;
      if (parentNode.raws?.selectorTemp) {
        const start = locStart(parentNode);
        const end = start + parentNode.raws.selectorTemp.length;
        return options.originalText.slice(start, end).trim();
      }

      // Same reason above
      const grandParent = path.grandparent;
      if (
        parentNode.type === "value-paren_group" &&
        grandParent?.type === "value-func" &&
        grandParent.value === "selector"
      ) {
        const start = locEnd(parentNode.open) + 1;
        const end = locStart(parentNode.close);
        const selector = options.originalText.slice(start, end).trim();

        return lastLineHasInlineComment(selector)
          ? [breakParent, selector]
          : selector;
      }

      return node.value;
    }

    // postcss-values-parser
    // case "value":
    // case "root":
    //   return print("group");

    // case "comment":
    //   return options.originalText.slice(locStart(node), locEnd(node));

    // case "comma_group":
    //   return printCommaSeparatedValueGroup(path, options, print);

    // case "paren_group":
    //   return printParenthesizedValueGroup(path, options, print);

    case "color":
      return node.value.toString();

    case "function-call":
      return node.toString();

    // case "func":
    //   return [
    //     node.value,
    //     insideAtRuleNode(path, "supports") && isMediaAndSupportsKeywords(node)
    //       ? " "
    //       : "",
    //     print("group"),
    //   ];

    case "list": {
      // TODO: Every node needs a `type`
      node.type = "list";
      // TODO: Need a way to determine if this list is wrapped in parens
      const hasParens = false;
      const parentNode = path.parent;
      const nodes = path.map(
        ({ node }) => (typeof node === "string" ? node : print()),
        "nodes",
      );
      // TODO: It looks like `url()` is just parsed as a `string`
      if (
        parentNode &&
        isURLFunctionNode(parentNode) &&
        (node.groups.length === 1 ||
          (node.groups.length > 0 &&
            node.groups[0].type === "value-comma_group" &&
            node.groups[0].groups.length > 0 &&
            node.groups[0].groups[0].type === "value-word" &&
            node.groups[0].groups[0].value.startsWith("data:")))
      ) {
        return [hasParens ? "(" : "", join(",", nodes), hasParens ? ")" : ""];
      }
      if (!hasParens) {
        const forceHardLine = path.match(
          (node) =>
            // TODO: The original `shouldBreakList()` checks for comma-groups
            node.some((node) =>
              ["list", "binary-operation"].includes(node.sassType),
            ),
          (node, key) =>
            key === "expression" &&
            ((node.type === "decl" && !node.prop.startsWith("--")) ||
              (node.type === "atrule" && node.variable)),
        );
        assertDocArray(nodes);
        const separator = (node.separator ?? "").trim();
        const withSeparator = chunk(join(separator, nodes), 2);
        const parts = join(forceHardLine ? hardline : line, withSeparator);
        return indent(
          forceHardLine
            ? [hardline, parts]
            : group([parentNode.type === "decl" ? softline : "", fill(parts)]),
        );
      }
      // TODO: We're not handling the logic for a paren-wrapped list
      return null;
    }

    // case "paren":
    //   return node.value;

    case "number":
      return [
        printCssNumber(node.value.toString()),
        printUnit(node.unit ?? ""),
      ];

    case "binary-operation":
      node.type = "binary-operation";
      return [print("left"), " ", node.operator, " ", print("right")];

    case "parenthesized":
      node.type = "parenthesized";
      return group(["(", indent([softline, print("inParens")]), softline, ")"]);

    case "selector-expr":
    case "variable":
      return node.toString();

    // case "word":
    //   if ((node.isColor && node.isHex) || isWideKeywords(node.value)) {
    //     return node.value.toLowerCase();
    //   }

    //   return node.value;

    // case "colon": {
    //   const { previous } = path;
    //   return group([
    //     node.value,
    //     // Don't add spaces on escaped colon `:`, e.g: grid-template-rows: [row-1-00\:00] auto;
    //     (typeof previous?.value === "string" &&
    //       previous.value.endsWith("\\")) ||
    //     // Don't add spaces on `:` in `url` function (i.e. `url(fbglyph: cross-outline, fig-white)`)
    //     insideValueFunctionNode(path, "url")
    //       ? ""
    //       : line,
    //   ]);
    // }

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

    // case "atword":
    //   return ["@", node.value];

    // case "unicode-range":
    //   return node.value;

    // case "unknown":
    //   return node.value;

    // case "comma": // Handled in `value-comma_group`
    default:
      /* c8 ignore next */
      throw new UnexpectedNodeError(
        node,
        "PostCSS",
        node.type ? "type" : "sassType",
      );
  }
}

const printer = {
  print: genericPrint,
  embed,
  insertPragma,
  massageAstNode: clean,
  getVisitorKeys,
};

export default printer;
