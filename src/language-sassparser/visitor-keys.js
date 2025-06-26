const visitorKeys = {
  root: ["nodes", "frontMatter"],
  comment: [],
  rule: ["selector", "nodes"],
  decl: ["nodes", "expression"],
  "variable-declaration": ["expression"],
  atrule: ["params", "nodes"],
  list: ["nodes"],
  map: ["nodes"],
  "argument-list": ["nodes"],
  argument: ["value"],
  "map-entry": ["key", "value"],
  parenthesized: ["inParens"],
  "binary-operation": ["left", "right"],
  string: [],
  "function-call": ["arguments"],
  unknown: [],
};

export default visitorKeys;
