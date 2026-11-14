import numpy as np
def hz2mel(f):  # Slaney (Auditory Toolbox): linear below 1 kHz, log above
    f=np.asarray(f,float); mel=f/(200/3)
    log=f>=1000; mel=np.where(log, 15+np.log(np.maximum(f,1e-9)/1000)/(np.log(6.4)/27), mel); return mel
def mel2hz(m):
    m=np.asarray(m,float); return np.where(m>=15, 1000*np.exp((m-15)*np.log(6.4)/27), m*200/3)
def filterbank(n_fft=512, sr=16000, n_mels=96, fmin=0, fmax=8000):
    bins=np.arange(n_fft//2+1)*sr/n_fft
    edges=mel2hz(np.linspace(hz2mel(fmin),hz2mel(fmax),n_mels+2))
    fb=np.zeros((n_mels,len(bins)))
    for i in range(n_mels):
        lo,c,hi=edges[i],edges[i+1],edges[i+2]
        up=(bins-lo)/(c-lo); down=(hi-bins)/(hi-c)
        fb[i]=np.maximum(0,np.minimum(up,down))
        fb[i]*=2/(hi-lo)  # unit_tri: unit area triangles
    return fb
FB=filterbank()
def hann(n): return 0.5-0.5*np.cos(2*np.pi*np.arange(n)/(n-1))
W=hann(512)
def mel(sig, frame=512, hop=256):
    # startFromZero frames; Essentia zero-pads the last partial frame
    out=[]
    for s in range(0, len(sig), hop):
        f=sig[s:s+frame]
        if len(f)<frame:
            if s+hop>len(sig) and len(f)<=frame//2 and s>0: break
            f=np.pad(f,(0,frame-len(f)))
        spec=np.abs(np.fft.rfft(f*W))
        out.append(np.log10(1+10000*(FB@(spec**2))))
    return np.array(out,np.float32)
