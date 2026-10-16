"""Original, reproducible SVG isometric city illustrations; no game assets included."""
import random
from pathlib import Path

OUT = Path(__file__).resolve().parents[1] / "static" / "art"
OUT.mkdir(parents=True, exist_ok=True)


def art(seed, hero=False):
    rng = random.Random(seed)
    parts = []
    bg = ["#a8b77e", "#95ad78", "#b6bd88", "#8cac8b", "#c1b27d", "#a3b781"][seed % 6]
    def point(x, y, z=0):
        return (320 + (x-y)*1.2, 75 + (x+y)*.60 - z)
    def polygon(points, color, stroke=None):
        coords = " ".join(f"{x:.1f},{y:.1f}" for x,y in points)
        parts.append(f'<polygon points="{coords}" fill="{color}"' + (f' stroke="{stroke}" stroke-width=".6"' if stroke else '') + '/>')
    def plane(x,y,w,d,c,z=0):
        polygon([point(x,y,z),point(x+w,y,z),point(x+w,y+d,z),point(x,y+d,z)],c)
    def box(x,y,w,d,h,colors):
        top,left,right=colors
        polygon([point(x,y,h),point(x,y+d,h),point(x,y+d),point(x,y)],left)
        polygon([point(x,y+d,h),point(x+w,y+d,h),point(x+w,y+d),point(x,y+d)],right)
        polygon([point(x+w,y,h),point(x+w,y+d,h),point(x+w,y+d),point(x+w,y)],right)
        plane(x,y,w,d,top,h)
    def tree(x,y):
        box(x,y,2,2,12,("#ad9b6d","#655f44","#776d44"))
        for z,w in [(12,15),(19,12),(26,9)]:
            polygon([point(x-w/2,y-w/2,z), point(x+w/2,y-w/2,z),point(x+w/2,y+w/2,z),point(x-w/2,y+w/2,z)],"#50794a")
            polygon([point(x-w/2,y+w/2,z),point(x+w/2,y+w/2,z),point(x,y,z+16)],"#679156")
            polygon([point(x-w/2,y-w/2,z),point(x-w/2,y+w/2,z),point(x,y,z+16)],"#396c4e")
    def building(x,y,w,d,h,color):
        palette={"brick":("#d8b68f","#ae6955","#8c5147"),"white":("#e4e0bc","#b9b69f","#949b8f"),"blue":("#a2b8b6","#6e9295","#52737c"),"red":("#bd815e","#8e5843","#744836")}[color]
        box(x,y,w,d,h,palette)
        for level in range(10,int(h)-4,11):
            for k in range(5,int(w)-4,9):
                polygon([point(x+k,y+d+.2,level),point(x+k+4,y+d+.2,level),point(x+k+4,y+d+.2,level+5),point(x+k,y+d+.2,level+5)],"#324b58")
            for k in range(5,int(d)-3,10):
                polygon([point(x-.2,y+k,level),point(x-.2,y+k+5,level),point(x-.2,y+k+5,level+5),point(x-.2,y+k,level+5)],"#445b59")
        plane(x+3,y+3,w-6,d-6,"#b7b8a4",h+.3)
        if w>25: box(x+8,y+9,9,9,7,("#d4d4bc","#aaa78f","#818f81")); plane(x+8,y+9,9,9,"#e1dccc",h+3)
    if not hero: parts.append(f'<rect width="640" height="420" fill="{bg}"/>')
    parts.append('<g>')
    polygon([point(-12,-8,-8),point(242,-8,-8),point(242,239,-8),point(-12,239,-8)],"#273f3955")
    box(-10,-10,250,250,0,("#89a06f","#718569","#718569"))
    polygon([point(-10,240),point(240,240),point(240,240,-9),point(-10,240,-9)],"#536b51")
    polygon([point(240,-10),point(240,240),point(240,240,-9),point(240,-10,-9)],"#687a5c")
    # Surface texture and a loop road.
    for _ in range(360):
        x,y=rng.uniform(-8,238),rng.uniform(-8,238)
        plane(x,y,1.3,1.3,rng.choice(["#91a67a","#7b9567","#9aab80"]))
    plane(9,11,218,218,"#bdbea6")
    plane(13,15,210,210,"#5e6b69")
    plane(34,36,168,168,"#c8c8ac")
    for v in range(23,220,13):
        plane(v,24,7,1,"#e7db9c");plane(v,214,7,1,"#e7db9c")
        plane(23,v,1,7,"#e7db9c");plane(213,v,1,7,"#e7db9c")
    if seed%6==3:
        plane(34,36,75,168,"#75a5a1")
        for v in range(48,191,16): plane(39,v,60,2,"#a2c6bb")
        plane(34,104,168,25,"#c8bfa2");plane(34,108,168,17,"#667573")
    else:
        plane(40,42,154,150,"#748078")
        for row in range(3):
            y=50+row*47
            for col in range(12):
                x=45+col*12
                plane(x,y,1,26,"#e4d991");plane(x,y,12,1,"#e4d991")
                if rng.random()>.36:
                    color=rng.choice([("#d8bc6c","#b5984e","#88784c"),("#d7dbcc","#adb7ab","#83948f"),("#a85c4c","#824c45","#5a4945"),("#69929a","#4f747c","#3e626b")])
                    box(x+3,y+5,7,16,5,color);plane(x+3.5,y+9,6,5,"#294a55",5.1)
    # Vertical objects are rendered from back to front.
    objects=[]
    layouts=[[(100,38,58,33,35,"brick"),(164,38,27,33,53,"white")],[(52,45,38,45,62,"blue"),(106,45,33,43,90,"brick"),(150,45,36,42,50,"white")],[(50,42,128,31,28,"white")],[(124,43,38,50,68,"white"),(167,145,25,42,47,"brick")],[(45,45,45,34,35,"red"),(106,45,70,34,25,"brick")],[(62,45,48,42,42,"brick"),(142,45,46,44,58,"blue")]]
    for b in layouts[seed%6]: objects.append((b[0]+b[1]+b[3],"building",b))
    for x,y in [(3,3),(43,3),(80,3),(115,3),(162,3),(205,3),(232,53),(232,103),(232,153),(232,198),(3,65),(3,120),(3,175),(58,232),(104,232),(151,232),(195,232)]:
        objects.append((x+y,"tree",(x,y)))
    for _,kind,args in sorted(objects,key=lambda o:o[0]):
        (building if kind=="building" else tree)(*args)
    # The familiar parking sign.
    box(179,186,2,2,33,("#d4ceb0","#b6b49b","#797f74"))
    sx,sy=point(179,186,36)
    parts.append(f'<rect x="{sx-8}" y="{sy-10}" width="17" height="20" fill="#245579" stroke="#f4e5b3" stroke-width="1.5"/><text x="{sx+.5}" y="{sy+5}" font-family="Arial" font-size="16" font-weight="bold" text-anchor="middle" fill="#faf0d1">P</text>')
    parts.append('</g>')
    svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 420" shape-rendering="crispEdges">'+''.join(parts)+'</svg>'
    # A livelier, limited-color palette suited to a construction-game viewport.
    for old, new in {"#89a06f": "#8caf5a", "#91a67a": "#a0bb68", "#7b9567": "#7ba351", "#9aab80": "#99b762", "#50794a": "#4b803b", "#679156": "#6b9f49", "#396c4e": "#356f3c", "#ae6955": "#b77051", "#6e9295": "#63969a"}.items():
        svg = svg.replace(old, new)
    return svg


def map_art():
    """A wide, original town scene with tiled terrain, for the overview viewport."""
    rng = random.Random(98)
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 450" shape-rendering="crispEdges">',
             '<defs><pattern id="grass" width="48" height="24" patternUnits="userSpaceOnUse"><rect width="48" height="24" fill="#8eac61"/><path d="M0 12 24 0 48 12 24 24Z" fill="#92af65"/><path d="M6 10h2v1H6zm23 5h2v1h-2zm12-11h2v1h-2z" fill="#78974f"/></pattern></defs>',
             '<rect width="1000" height="450" fill="url(#grass)"/>',
             '<path d="M710 0 1000 145v60L590 0Z" fill="#c2bc8c"/><path d="M730 0 1000 135v43L644 0Z" fill="#6e8075"/>',
             '<path d="M690 0 1000 155" fill="none" stroke="#e8dca1" stroke-width="2" stroke-dasharray="11 9"/>']
    for _ in range(100):
        x, y = rng.randrange(1000), rng.randrange(450)
        if 405 < x < 960 and 70 < y < 380:
            continue
        parts.append(f'<g transform="translate({x} {y})"><path d="M-9 9 1 4 12 9 1 15Z" fill="#78964f"/><path d="M0 0h3v12H0z" fill="#796d41"/><path d="M-8 3 1-19 10 3Z" fill="#43783b"/><path d="M1-19 10 3 1 3Z" fill="#609344"/><path d="M-6-4 1-23 8-4Z" fill="#6b9b49"/></g>')
    # Each embedded SVG is generated above; no external images or game assets.
    for seed, x, y, width in [(4, 140, -85, 420), (1, 370, 5, 640), (3, 110, 275, 470)]:
        town = art(seed, True).replace('<svg ', f'<svg x="{x}" y="{y}" width="{width}" height="{width*420/640}" ', 1)
        parts.append(town)
    parts.append('</svg>')
    return ''.join(parts)

for i in range(6): (OUT/f"lot-{i}.svg").write_text(art(i))
(OUT/"city.svg").write_text(art(1,True))
(OUT/"map.svg").write_text(map_art())
(OUT/"terrain.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><path d="M3 8h2v1H3zm21 7h1v2h-1zm33-11h2v1h-2zM9 42h1v2H9zm31-7h2v1h-2zm33 12h1v2h-1zM24 68h2v1h-2zm31-8h1v2h-1z" fill="#d7dea4" opacity=".12"/><path d="M11 20h2v1h-2zm35-7h2v1h-2zm19 20h1v2h-1zM30 49h1v2h-1zm14 26h2v1h-2z" fill="#172f24" opacity=".22"/></svg>')
(OUT/"paper.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" width="50" height="50"><path d="M4 9h1v1H4zm20 8h2v1h-2zm15-13h1v1h-1zM14 35h1v1h-1zm28 7h1v1h-1z" fill="#836b43" opacity=".12"/><path d="M17 6h2v1h-2zm17 25h2v1h-2zM4 46h2v1H4z" fill="#fff8da" opacity=".3"/></svg>')
(OUT/"favicon.svg").write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="1" y="1" width="30" height="30" fill="#123e79" stroke="#efdc9a" stroke-width="2"/><text x="16" y="24" fill="white" font-family="Arial" font-weight="bold" font-size="25" text-anchor="middle">P</text></svg>')
