'use strict'

const opentype = require('opentype.js')
const FontSubset = require('./subset')
const PDFName = require('./object/name')
const PDFObject = require('./object/object')
const PDFDictionary = require('./object/dictionary')
const PDFString = require('./object/string')
const PDFArray = require('./object/array')
const PDFStream = require('./object/stream')

module.exports = class Font {
  constructor(b) {
    // convert to array buffer
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)
    this.font = opentype.parse(ab)

    this.alias = new PDFName('F' + 1)

    this.subset = new FontSubset(this.font)
    this.subset.use(' ')

    this.object = new PDFObject('Font')
  }

  encode(str) {
    this.subset.use(str)
    return this.subset.encode(str)
  }

  async write(doc) {
    var head = this.font.tables.head

    const scaleFactor = 1000.0 / this.font.unitsPerEm

    let flags = 0
    const familyClass = (this.font.tables.os2.sFamilyClass || 0) >> 8
    const isSerif = !!~[1, 2, 3, 4, 5, 6, 7].indexOf(familyClass)
    const isFixedPitch = this.font.tables.post.isFixedPitch
    const italicAngle = this.font.tables.post.italicAngle

    if (isFixedPitch)                  flags |= 1 << 0
    if (isSerif)                       flags |= 1 << 1
    if (familyClass === 10)            flags |= 1 << 3
    if (italicAngle !== 0)             flags |= 1 << 6
    /* assume not being symbolic */    flags |= 1 << 5

    // font descriptor
    const descriptor = new PDFObject('FontDescriptor')
    descriptor.prop('FontName', this.subset.name)
    descriptor.prop('Flags', flags)
    descriptor.prop('FontBBox', new PDFArray([
      head.xMin * scaleFactor, head.yMin * scaleFactor,
      head.xMax * scaleFactor, head.yMax * scaleFactor
    ]))
    descriptor.prop('ItalicAngle', italicAngle)
    descriptor.prop('Ascent', this.font.tables.os2.sTypoAscender * scaleFactor)
    descriptor.prop('Descent', this.font.tables.os2.sTypoDescender * scaleFactor)
    descriptor.prop('CapHeight', this.font.tables.os2.sTypoLineGap * scaleFactor)
    descriptor.prop('StemV', 0)

    const descendant = new PDFObject('Font')
    descendant.prop('Subtype', 'CIDFontType0')
    descendant.prop('BaseFont', this.font.names.postScriptName.en)
    descendant.prop('DW', 1000)
    descendant.prop('CIDToGIDMap', 'Identity')
    descendant.prop('CIDSystemInfo', new PDFDictionary({
      'Ordering':   new PDFString('Identity'),
      'Registry':   new PDFString('Adobe'),
      'Supplement': 0
    }))
    descendant.prop('FontDescriptor', descriptor.toReference())

    const font = this.object
    font.prop('Subtype', 'Type0')
    font.prop('BaseFont', this.font.names.postScriptName.en)
    font.prop('Encoding', 'Identity-H')
    font.prop('DescendantFonts', new PDFArray([descendant.toReference()]))

    // widths array
    const metrics = [], codeMap = this.subset.cmap()
    for (const code in codeMap) {
      if (code < 32) {
        continue
      }

      const width = Math.round(this.subset.glyphs[code].advanceWidth * scaleFactor)
      metrics.push(code - 31)
      metrics.push(new PDFArray([width]))
    }

    descendant.prop('W', new PDFArray(metrics))

    // unicode map
    const cmap = new PDFStream()
    cmap.writeLine('/CIDInit /ProcSet findresource begin')
    cmap.writeLine('12 dict begin')
    cmap.writeLine('begincmap')
    cmap.writeLine('/CIDSystemInfo <<')
    cmap.writeLine('  /Registry (Adobe)')
    cmap.writeLine('  /Ordering (Identity)')
    cmap.writeLine('  /Supplement 0')
    cmap.writeLine('>> def')
    cmap.writeLine('/CMapName /Identity-H')
    cmap.writeLine('/CMapType 2 def')
    cmap.writeLine('1 begincodespacerange')
    cmap.writeLine('<0000><ffff>')
    cmap.writeLine('endcodespacerange')

    const mapping = this.subset.subset, lines = []
    for (const code in mapping) {
      if (code < 32) {
        continue
      }

      if (lines.length >= 100) {
        cmap.writeLine(lines.length + ' beginbfchar')
        for (var i = 0; i < lines.length; ++i) {
          cmap.writeLine(lines[i])
        }
        cmap.writeLine('endbfchar')
        lines = []
      }

      lines.push(
        '<' + ('0000' + (+code - 31).toString(16)).slice(-4) + '>' + // cid
        '<' + ('0000' + mapping[code].toString(16)).slice(-4) + '>'  // gid
      )
    }

    if (lines.length) {
      cmap.writeLine(lines.length + ' beginbfchar')
      lines.forEach(function(line) {
        cmap.writeLine(line)
      })
      cmap.writeLine('endbfchar')
    }

    cmap.writeLine('endcmap')
    cmap.writeLine('CMapName currentdict /CMap defineresource pop')
    cmap.writeLine('end')
    cmap.writeLine('end')

    font.prop('ToUnicode', cmap.toReference())

    // font file
    const data = this.subset.save()
    const hex = ab2hex(data)

    const file = new PDFStream()
    file.object.prop('Subtype', 'CIDFontType0C')
    file.object.prop('Length', hex.length + 1)
    file.object.prop('Length1', data.byteLength)
    file.object.prop('Filter', 'ASCIIHexDecode')
    file.content = hex + '>\n'

    descriptor.prop('FontFile3', file.toReference())

    await doc.writeObject(file)
    await doc.writeObject(descriptor)
    await doc.writeObject(descendant)
    await doc.writeObject(cmap)
    await doc.writeObject(font)
  }
}

function toHex(n) {
  if (n < 16) return '0' + n.toString(16)
  return n.toString(16)
}

function ab2hex(ab) {
  const view = new Uint8Array(ab)
  let hex = ''
  for (let i = 0, len = ab.byteLength; i < len; ++i) {
    hex += toHex(view[i])
  }
  return hex
}