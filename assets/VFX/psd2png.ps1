param(
  [Parameter(Mandatory=$true)][string]$In,
  [Parameter(Mandatory=$true)][string]$Out,
  [int]$Size = 0   # 0 = behall original, annars skala (kvadrat) till Size
)

Add-Type -ReferencedAssemblies "System.Drawing" -ErrorAction SilentlyContinue -TypeDefinition @'
using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

public static class Psd2Png {
  static int BE16(byte[] b, int o){ return (b[o]<<8)|b[o+1]; }
  static long BE32(byte[] b, int o){ return ((long)b[o]<<24)|((long)b[o+1]<<16)|((long)b[o+2]<<8)|b[o+3]; }

  public static void Convert(string inPath, string outPath, int size){
    byte[] d = File.ReadAllBytes(inPath);
    if(!(d[0]==0x38&&d[1]==0x42&&d[2]==0x50&&d[3]==0x53)) throw new Exception("inte en PSD (8BPS saknas)");
    int channels = BE16(d,12);
    int height = (int)BE32(d,14);
    int width  = (int)BE32(d,18);
    int depth  = BE16(d,22);
    if(depth!=8) throw new Exception("stodjer bara 8-bit, fick "+depth);

    int p = 26;
    long cmLen = BE32(d,p); p += 4 + (int)cmLen;       // color mode data
    long irLen = BE32(d,p); p += 4 + (int)irLen;       // image resources
    long lmLen = BE32(d,p); p += 4 + (int)lmLen;       // layer & mask
    int compression = BE16(d,p); p += 2;               // 0=raw, 1=RLE

    int wh = width*height;
    byte[][] plane = new byte[channels][];
    for(int c=0;c<channels;c++) plane[c]=new byte[wh];

    if(compression==1){
      // scanline byte-counts: channels*height uint16 BE
      int countsBytes = channels*height*2;
      int[] counts = new int[channels*height];
      int cp = p;
      for(int i=0;i<channels*height;i++){ counts[i]=BE16(d,cp); cp+=2; }
      int dataPos = p + countsBytes;
      int idx=0;
      for(int c=0;c<channels;c++){
        byte[] plane_c = plane[c];
        for(int y=0;y<height;y++){
          int len = counts[idx++];
          int end = dataPos + len;
          int rowStart = y*width;
          int x=0;
          while(dataPos<end){
            sbyte n = (sbyte)d[dataPos++];
            if(n>=0){
              int cnt=n+1;
              for(int k=0;k<cnt;k++){ if(x<width) plane_c[rowStart+x]=d[dataPos]; dataPos++; x++; }
            } else if(n!=-128){
              int cnt=1-n;
              byte v=d[dataPos++];
              for(int k=0;k<cnt;k++){ if(x<width) plane_c[rowStart+x]=v; x++; }
            }
          }
          dataPos=end;
        }
      }
    } else {
      // raw planar
      int rp=p;
      for(int c=0;c<channels;c++){ Array.Copy(d,rp,plane[c],0,wh); rp+=wh; }
    }

    // bygg BGRA-buffer for Format32bppArgb
    Bitmap bmp = new Bitmap(width,height,PixelFormat.Format32bppArgb);
    Rectangle rect = new Rectangle(0,0,width,height);
    BitmapData bd = bmp.LockBits(rect,ImageLockMode.WriteOnly,PixelFormat.Format32bppArgb);
    int stride = bd.Stride;
    byte[] buf = new byte[stride*height];
    byte[] R=plane[0], G=channels>1?plane[1]:plane[0], B=channels>2?plane[2]:plane[0];
    byte[] A=channels>3?plane[3]:null;
    for(int y=0;y<height;y++){
      int so=y*width; int do2=y*stride;
      for(int x=0;x<width;x++){
        int si=so+x; int di=do2+x*4;
        buf[di+0]=B[si]; buf[di+1]=G[si]; buf[di+2]=R[si];
        buf[di+3]= A!=null ? A[si] : (byte)255;
      }
    }
    Marshal.Copy(buf,0,bd.Scan0,buf.Length);
    bmp.UnlockBits(bd);

    Bitmap outBmp = bmp;
    if(size>0 && size!=width){
      Bitmap scaled = new Bitmap(size,size,PixelFormat.Format32bppArgb);
      using(Graphics g=Graphics.FromImage(scaled)){
        g.InterpolationMode=InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode=PixelOffsetMode.HighQuality;
        g.CompositingQuality=CompositingQuality.HighQuality;
        g.DrawImage(bmp,new Rectangle(0,0,size,size),new Rectangle(0,0,width,height),GraphicsUnit.Pixel);
      }
      outBmp=scaled;
    }
    outBmp.Save(outPath,ImageFormat.Png);
    Console.WriteLine("OK "+outPath+"  ("+width+"x"+height+" ch="+channels+" comp="+compression+") -> "+(size>0?size:width)+"px");
  }
}
'@

[Psd2Png]::Convert((Resolve-Path $In).Path, $Out, $Size)
