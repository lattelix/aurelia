"""Original procedural artwork and instrumental sketches. No source recordings.
Audio/art output is dedicated to CC0. Requires numpy and ffmpeg; not needed at runtime.
"""
from pathlib import Path
import math, subprocess, tempfile, wave
import numpy as np

root=Path(__file__).resolve().parents[1]/'apps/web/public'
palettes=[('afterglow','#d8aa6f','#795347','#352c38'),('blue-hours','#9cc8d4','#4b819d','#18283e'),('parallel','#d990ba','#654c92','#272840'),('still-life','#adc19b','#57705f','#1f3833')]
for name,top,middle,bottom in palettes:
    svg=f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 800"><defs><linearGradient id="sky" x2="0" y2="1"><stop stop-color="{top}"/><stop offset="1" stop-color="{bottom}"/></linearGradient><radialGradient id="sun"><stop stop-color="#fff2cd"/><stop offset=".98" stop-color="{top}"/></radialGradient><filter id="grain"><feTurbulence baseFrequency=".45" numOctaves="3" seed="8"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".13"/></feComponentTransfer><feBlend in="SourceGraphic" mode="soft-light"/></filter></defs><g filter="url(#grain)"><path fill="url(#sky)" d="M0 0h800v800H0z"/><circle cx="480" cy="270" r="110" fill="url(#sun)"/><path fill="{middle}" d="M0 490 140 350 265 475 440 440 670 290 800 370V800H0Z"/><path fill="{bottom}" opacity=".8" d="M0 530Q220 420 390 585T800 570V800H0Z"/><path fill="{bottom}" d="M0 650Q280 530 480 720L800 660V800H0Z"/><path d="M290 800Q460 630 375 570" stroke="{top}" stroke-width="3" fill="none" opacity=".5"/></g><text x="58" y="82" fill="#fff5e8" font-family="Helvetica,Arial,sans-serif" font-size="14" letter-spacing="6">AURELIA STUDIO</text></svg>'''
    (root/'art'/f'{name}.svg').write_text(svg)
hero='''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1500 650"><defs><linearGradient id="s" x2="1" y2="1"><stop stop-color="#252521"/><stop offset=".5" stop-color="#9d704b"/><stop offset="1" stop-color="#e7b880"/></linearGradient><radialGradient id="sun"><stop stop-color="#ffe3a4"/><stop offset="1" stop-color="#db9861"/></radialGradient><filter id="g"><feTurbulence baseFrequency=".32" numOctaves="3"/><feColorMatrix type="saturate" values="0"/><feComponentTransfer><feFuncA type="linear" slope=".1"/></feComponentTransfer><feBlend in="SourceGraphic" mode="soft-light"/></filter></defs><g filter="url(#g)"><path fill="url(#s)" d="M0 0h1500v650H0z"/><circle cx="1100" cy="235" r="119" fill="url(#sun)"/><path fill="#806046" d="m500 400 250-130 180 110 170-72 200 100 200-98v340H500Z"/><path fill="#4b493a" d="M0 550Q180 490 470 570 800 610 940 429 1170 339 1500 455V650H0Z"/><path fill="#242b25" d="M0 565Q350 475 650 645 1000 500 1500 610V650H0Z"/></g></svg>'''
(root/'art'/'hero.svg').write_text(hero)
(root/'art'/'artist.svg').write_text((root/'art'/'parallel.svg').read_text())
icon='''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="116" fill="#171918"/><g stroke="#e7bb7a" stroke-width="29" stroke-linecap="round"><path d="M135 250v12M195 192v128M256 133v246M317 192v128M377 250v12"/></g></svg>'''
(root/'icon.svg').write_text(icon)

sample_rate=22050
length=72
time=np.arange(sample_rate*length)/sample_rate
def note(midi): return 440*2**((midi-69)/12)
for number in range(1,13):
    rng=np.random.default_rng(number*41)
    group=(number-1)//3
    bpm=[94,72,112,82][group]+(number%3)*2
    beat=60/bpm
    audio=np.zeros(len(time))
    progression=[[57,60,64,67],[53,57,60,64],[60,64,67,71],[55,59,62,65]]
    transpose=[0,2,-2,5][group]+(number%3-1)*2
    for bar in range(math.ceil(length/(beat*4))):
        start=bar*beat*4
        notes=[n+transpose for n in progression[(bar//2+number)%4]]
        idx=int(start*sample_rate)
        n=min(int(beat*4.5*sample_rate),len(audio)-idx)
        if n<=0: continue
        t=np.arange(n)/sample_rate
        envelope=np.minimum(1,t/.3)*np.minimum(1,(n/sample_rate-t)/.7)
        chord=sum(np.sin(2*np.pi*note(m)*t+.008*np.sin(2*np.pi*.4*t))+.15*np.sin(4*np.pi*note(m)*t) for m in notes)/4
        audio[idx:idx+n]+=chord*envelope*.13
        for step in range(8):
            onset=start+step*beat/2
            offset=int(onset*sample_rate)
            count=min(int(beat*1.8*sample_rate),len(audio)-offset)
            if count<=0: continue
            t=np.arange(count)/sample_rate
            melody=note(notes[(step+bar)%4]+12)
            tone=(np.sin(2*np.pi*melody*t)+.2*np.sin(2*np.pi*melody*2*t))*np.exp(-t/(.2 if group!=1 else .7))*np.minimum(1,t/.006)
            if group!=1 or step%2==0: audio[offset:offset+count]+=tone*.13
        for step in range(4):
            onset=start+step*beat
            offset=int(onset*sample_rate)
            count=min(int(beat*.85*sample_rate),len(audio)-offset)
            if count<=0: continue
            t=np.arange(count)/sample_rate
            audio[offset:offset+count]+=np.sin(2*np.pi*note(notes[0]-24)*t)*np.exp(-t/.4)*.19
            if group!=1 and bar>1:
                kick=np.sin(2*np.pi*(48*t+7*(1-np.exp(-t*25))))*np.exp(-t*16)*.24
                audio[offset:offset+count]+=kick
                if step%2==1: audio[offset:offset+count]+=rng.normal(size=count)*np.exp(-t*38)*.08
            if group!=1:
                audio[offset:offset+count]+=rng.normal(size=count)*np.exp(-t*110)*.024
    audio*=np.minimum(1,time/4)*np.minimum(1,(length-time)/7)
    audio=np.tanh(audio*1.5)
    stereo=np.stack([audio,np.roll(audio,35)*.98],axis=1)
    with tempfile.NamedTemporaryFile(suffix='.wav') as tmp:
        with wave.open(tmp.name,'wb') as wav:
            wav.setnchannels(2);wav.setsampwidth(2);wav.setframerate(sample_rate);wav.writeframes((stereo*24000).astype('<i2').tobytes())
        subprocess.run(['ffmpeg','-y','-loglevel','error','-i',tmp.name,'-b:a','96k',str(root/'audio'/f'{number}.mp3')],check=True)
    print(f'Original sketch {number}/12 rendered')
