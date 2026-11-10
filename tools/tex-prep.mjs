// 디테일 텍스처 준비: 회색조로 바꾸고 평균 밝기를 맞춰(색 위에 곱해도 어두워지지 않게) JPG로 저장 + 4분할 미리보기
// usage: node tools/tex-prep.mjs <src.png> <dst.jpg> [size=1024] [mean=205] [contrast=1.0] [invert]
// invert: 명암을 뒤집는다(패널 선이 밝게). 검은 재질은 곱해도 선이 안 보여서, 뒤집은 텍스처에 재질 색을 밝혀 곱한다.
import sharp from 'sharp';
const [src, dst, sizeArg = '1024', meanArg = '205', contrastArg = '1', invertArg = ''] = process.argv.slice(2);
const size = Number(sizeArg), target = Number(meanArg), k = Number(contrastArg) * (invertArg === 'invert' ? -1 : 1);
const base = sharp(src).resize(size, size).grayscale();
const stats = await base.clone().stats();
const mean = stats.channels[0].mean;
// out = (in - mean) * k + target
const buf = await base.linear(k, target - mean * k).toColourspace('srgb').jpeg({ quality: 86 }).toBuffer();
await sharp(buf).toFile(dst);
const out = await sharp(dst).stats();
console.log(dst, 'mean', mean.toFixed(0), '->', out.channels[0].mean.toFixed(0), (buf.length / 1024).toFixed(0) + 'KB');
