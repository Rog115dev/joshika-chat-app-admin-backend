function str(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripDocIds(docs) {
  return (Array.isArray(docs) ? docs : []).map((doc) => {
    const obj = { ...doc };
    delete obj._id;
    delete obj.__v;
    return obj;
  });
}

function stripMongoId(doc) {
  if (!doc) return null;
  const obj = typeof doc.toObject === 'function' ? doc.toObject() : { ...doc };
  delete obj._id;
  delete obj.__v;
  return obj;
}

module.exports = { str, stripDocIds, stripMongoId };
